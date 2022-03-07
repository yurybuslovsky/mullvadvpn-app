import * as grpc from '@grpc/grpc-js';
import {
  BoolValue,
  StringValue,
  UInt32Value,
} from 'google-protobuf/google/protobuf/wrappers_pb.js';
import { Empty } from 'google-protobuf/google/protobuf/empty_pb.js';
import { promisify } from 'util';
import {
  AccountToken,
  Constraint,
  IRelayListCountry,
  IRelayListCity,
  IRelayListHostname,
  IWireguardTunnelData,
  IBridgeConstraints,
  IWireguardConstraints,
  ITunnelOptions,
  IOpenVpnConstraints,
  IRelayList,
  IShadowsocksEndpointData,
  RelayProtocol,
  BridgeSettings,
  FirewallPolicyError,
  BridgeState,
  ILocation,
  IAppVersionInfo,
  IAccountData,
  IOpenVpnTunnelData,
  TunnelState,
  AfterDisconnect,
  IErrorState,
  ErrorStateCause,
  TunnelParameterError,
  ITunnelStateRelayInfo,
  TunnelType,
  IProxyEndpoint,
  ProxyType,
  ISettings,
  ConnectionConfig,
  DaemonEvent,
  RelaySettings,
  RelaySettingsUpdate,
  RelayLocation,
  ProxySettings,
  VoucherResponse,
  TunnelProtocol,
  IDnsOptions,
  DeviceConfig,
  IDevice,
  IDeviceRemoval,
  IDeviceEvent,
} from '../shared/daemon-rpc-types';
import log from '../shared/logging';

import { ManagementServiceClient } from './management_interface/management_interface_grpc_pb';
import * as grpcTypes from './management_interface/management_interface_pb';
import { CommunicationError, InvalidAccountError, TooManyDevicesError } from './errors';

const NETWORK_CALL_TIMEOUT = 10000;
const CHANNEL_STATE_TIMEOUT = 1000 * 60 * 60;

const noConnectionError = new Error('No connection established to daemon');
const configNotSupported = new Error('Setting custom settings is not supported');
const invalidErrorStateCause = new Error(
  'VPN_PERMISSION_DENIED is not a valid error state cause on desktop',
);

export class ConnectionObserver {
  constructor(private openHandler: () => void, private closeHandler: (error?: Error) => void) {}

  // Only meant to be called by DaemonRpc
  // @internal
  public onOpen = () => {
    this.openHandler();
  };

  // Only meant to be called by DaemonRpc
  // @internal
  public onClose = (error?: Error) => {
    this.closeHandler(error);
  };
}

export class SubscriptionListener<T> {
  // Only meant to be used by DaemonRpc
  // @internal
  public subscriptionId?: number;

  constructor(
    private eventHandler: (payload: T) => void,
    private errorHandler: (error: Error) => void,
  ) {}

  // Only meant to be called by DaemonRpc
  // @internal
  public onEvent(payload: T) {
    this.eventHandler(payload);
  }

  // Only meant to be called by DaemonRpc
  // @internal
  public onError(error: Error) {
    this.errorHandler(error);
  }
}

export class ResponseParseError extends Error {
  constructor(message: string) {
    super(message);
  }
}

type CallFunctionArgument<T, R> =
  | ((arg: T, callback: (error: Error | null, result: R) => void) => void)
  | undefined;

export class DaemonRpc {
  private client: ManagementServiceClient;
  private isConnected = false;
  private connectionObservers: ConnectionObserver[] = [];
  private nextSubscriptionId = 0;
  private subscriptions: Map<number, grpc.ClientReadableStream<grpcTypes.DaemonEvent>> = new Map();
  private reconnectionTimeout?: NodeJS.Timer;

  constructor(connectionParams: string) {
    this.client = new ManagementServiceClient(
      connectionParams,
      grpc.credentials.createInsecure(),
      this.channelOptions(),
    );
  }

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.waitForReady(this.deadlineFromNow(), (error) => {
        if (error) {
          this.connectionObservers.forEach((observer) => observer.onClose(error));
          this.ensureConnectivity();
          reject(error);
        } else {
          this.reconnectionTimeout = undefined;
          this.isConnected = true;
          this.connectionObservers.forEach((observer) => observer.onOpen());
          this.setChannelCallback();
          resolve();
        }
      });
    });
  }

  public disconnect() {
    this.isConnected = false;

    for (const subscriptionId of this.subscriptions.keys()) {
      this.removeSubscription(subscriptionId);
    }

    this.client.close();
    if (this.reconnectionTimeout) {
      clearTimeout(this.reconnectionTimeout);
    }
  }

  public addConnectionObserver(observer: ConnectionObserver) {
    this.connectionObservers.push(observer);
    // Call getConnectivityState(true) to start connecting if idle
    this.client.getChannel()?.getConnectivityState(true);
  }

  public removeConnectionObserver(observer: ConnectionObserver) {
    const index = this.connectionObservers.indexOf(observer);
    if (index !== -1) {
      this.connectionObservers.splice(index, 1);
    }
  }

  public async getAccountData(accountToken: AccountToken): Promise<IAccountData> {
    try {
      const response = await this.callString<grpcTypes.AccountData>(
        this.client.getAccountData,
        accountToken,
      );
      const expiry = response.getExpiry()!.toDate().toISOString();
      return { expiry };
    } catch (e) {
      const error = e as grpc.ServiceError;
      if (error.code) {
        switch (error.code) {
          case grpc.status.UNAUTHENTICATED:
            throw new InvalidAccountError();
          default:
            throw new CommunicationError();
        }
      }
      throw error;
    }
  }

  public async getWwwAuthToken(): Promise<string> {
    const response = await this.callEmpty<StringValue>(this.client.getWwwAuthToken);
    return response.getValue();
  }

  public async submitVoucher(voucherCode: string): Promise<VoucherResponse> {
    try {
      const response = await this.callString<grpcTypes.VoucherSubmission>(
        this.client.submitVoucher,
        voucherCode,
      );

      const secondsAdded = ensureExists(
        response.getSecondsAdded(),
        "no 'secondsAdded' field in voucher response",
      );
      const newExpiry = ensureExists(
        response.getNewExpiry(),
        "no 'newExpiry' field in voucher response",
      )
        .toDate()
        .toISOString();
      return {
        type: 'success',
        secondsAdded,
        newExpiry,
      };
    } catch (e) {
      const error = e as grpc.ServiceError;
      if (error.code) {
        switch (error.code) {
          case grpc.status.NOT_FOUND:
            return { type: 'invalid' };
          case grpc.status.RESOURCE_EXHAUSTED:
            return { type: 'already_used' };
        }
      }
      return { type: 'error' };
    }
  }

  public getRelayLocations(): Promise<IRelayList> {
    if (this.isConnected) {
      return new Promise((resolve, reject) => {
        const relayLocations: IRelayListCountry[] = [];
        const stream = this.client.getRelayLocations(new Empty());
        stream.on('data', (country: grpcTypes.RelayListCountry) =>
          relayLocations.push(convertFromRelayListCountry(country.toObject())),
        );
        stream.on('end', () => resolve({ countries: relayLocations }));
        stream.on('close', reject);
      });
    } else {
      throw noConnectionError;
    }
  }

  public async createNewAccount(): Promise<string> {
    const response = await this.callEmpty<StringValue>(this.client.createNewAccount);
    return response.getValue();
  }

  public async loginAccount(accountToken: AccountToken): Promise<void> {
    try {
      await this.callString(this.client.loginAccount, accountToken);
    } catch (e) {
      const error = e as grpc.ServiceError;
      if (error.code == grpc.status.RESOURCE_EXHAUSTED) {
        throw new TooManyDevicesError();
      } else {
        throw error;
      }
    }
  }

  public async logoutAccount(): Promise<void> {
    await this.callEmpty(this.client.logoutAccount);
  }

  // TODO: Custom tunnel configurations are not supported by the GUI.
  public async updateRelaySettings(relaySettings: RelaySettingsUpdate): Promise<void> {
    if ('normal' in relaySettings) {
      const settingsUpdate = relaySettings.normal;
      const grpcRelaySettings = new grpcTypes.RelaySettingsUpdate();

      const normalUpdate = new grpcTypes.NormalRelaySettingsUpdate();

      if (settingsUpdate.tunnelProtocol) {
        const tunnelTypeUpdate = new grpcTypes.TunnelTypeUpdate();
        tunnelTypeUpdate.setTunnelType(
          convertToTunnelTypeConstraint(settingsUpdate.tunnelProtocol),
        );
        normalUpdate.setTunnelType(tunnelTypeUpdate);
      }

      if (settingsUpdate.location) {
        normalUpdate.setLocation(convertToLocation(liftConstraint(settingsUpdate.location)));
      }

      if (settingsUpdate.wireguardConstraints) {
        normalUpdate.setWireguardConstraints(
          convertToWireguardConstraints(settingsUpdate.wireguardConstraints),
        );
      }

      if (settingsUpdate.openvpnConstraints) {
        normalUpdate.setOpenvpnConstraints(
          convertToOpenVpnConstraints(settingsUpdate.openvpnConstraints),
        );
      }

      if (settingsUpdate.providers) {
        const providerUpdate = new grpcTypes.ProviderUpdate();
        providerUpdate.setProvidersList(settingsUpdate.providers);
        normalUpdate.setProviders(providerUpdate);
      }

      grpcRelaySettings.setNormal(normalUpdate);
      await this.call<grpcTypes.RelaySettingsUpdate, Empty>(
        this.client.updateRelaySettings,
        grpcRelaySettings,
      );
    }
  }

  public async setAllowLan(allowLan: boolean): Promise<void> {
    await this.callBool(this.client.setAllowLan, allowLan);
  }

  public async setShowBetaReleases(showBetaReleases: boolean): Promise<void> {
    await this.callBool(this.client.setShowBetaReleases, showBetaReleases);
  }

  public async setEnableIpv6(enableIpv6: boolean): Promise<void> {
    await this.callBool(this.client.setEnableIpv6, enableIpv6);
  }

  public async setBlockWhenDisconnected(blockWhenDisconnected: boolean): Promise<void> {
    await this.callBool(this.client.setBlockWhenDisconnected, blockWhenDisconnected);
  }

  public async setBridgeState(bridgeState: BridgeState): Promise<void> {
    const bridgeStateMap = {
      auto: grpcTypes.BridgeState.State.AUTO,
      on: grpcTypes.BridgeState.State.ON,
      off: grpcTypes.BridgeState.State.OFF,
    };

    const grpcBridgeState = new grpcTypes.BridgeState();
    grpcBridgeState.setState(bridgeStateMap[bridgeState]);
    await this.call<grpcTypes.BridgeState, Empty>(this.client.setBridgeState, grpcBridgeState);
  }

  public async setBridgeSettings(bridgeSettings: BridgeSettings): Promise<void> {
    const grpcBridgeSettings = new grpcTypes.BridgeSettings();

    if ('normal' in bridgeSettings) {
      const normalSettings = convertToNormalBridgeSettings(bridgeSettings.normal);
      grpcBridgeSettings.setNormal(normalSettings);
    }

    if ('custom' in bridgeSettings) {
      throw configNotSupported;
    }

    await this.call<grpcTypes.BridgeSettings, Empty>(
      this.client.setBridgeSettings,
      grpcBridgeSettings,
    );
  }

  public async setOpenVpnMssfix(mssfix?: number): Promise<void> {
    await this.callNumber(this.client.setOpenvpnMssfix, mssfix);
  }

  public async setWireguardMtu(mtu?: number): Promise<void> {
    await this.callNumber(this.client.setWireguardMtu, mtu);
  }

  public async setAutoConnect(autoConnect: boolean): Promise<void> {
    await this.callBool(this.client.setAutoConnect, autoConnect);
  }

  public async connectTunnel(): Promise<void> {
    await this.callEmpty(this.client.connectTunnel);
  }

  public async disconnectTunnel(): Promise<void> {
    await this.callEmpty(this.client.disconnectTunnel);
  }

  public async reconnectTunnel(): Promise<void> {
    await this.callEmpty(this.client.reconnectTunnel);
  }

  public async getLocation(): Promise<ILocation> {
    const response = await this.callEmpty<grpcTypes.GeoIpLocation>(this.client.getCurrentLocation);
    return response.toObject();
  }

  public async getState(): Promise<TunnelState> {
    const response = await this.callEmpty<grpcTypes.TunnelState>(this.client.getTunnelState);
    return convertFromTunnelState(response)!;
  }

  public async getSettings(): Promise<ISettings> {
    const response = await this.callEmpty<grpcTypes.Settings>(this.client.getSettings);
    return convertFromSettings(response)!;
  }

  public subscribeDaemonEventListener(listener: SubscriptionListener<DaemonEvent>) {
    const call = this.isConnected && this.client.eventsListen(new Empty());
    if (!call) {
      throw noConnectionError;
    }
    const subscriptionId = this.subscriptionId();
    listener.subscriptionId = subscriptionId;
    this.subscriptions.set(subscriptionId, call);

    call.on('data', (data: grpcTypes.DaemonEvent) => {
      try {
        const daemonEvent = convertFromDaemonEvent(data);
        listener.onEvent(daemonEvent);
      } catch (e) {
        const error = e as Error;
        listener.onError(error);
      }
    });

    call.on('error', (error) => {
      listener.onError(error);
      this.removeSubscription(subscriptionId);
    });
  }

  public unsubscribeDaemonEventListener(listener: SubscriptionListener<DaemonEvent>) {
    const id = listener.subscriptionId;
    if (id !== undefined) {
      this.removeSubscription(id);
    }
  }

  public async getAccountHistory(): Promise<AccountToken | undefined> {
    const response = await this.callEmpty<grpcTypes.AccountHistory>(this.client.getAccountHistory);
    return response.getToken()?.getValue();
  }

  public async clearAccountHistory(): Promise<void> {
    await this.callEmpty(this.client.clearAccountHistory);
  }

  public async getCurrentVersion(): Promise<string> {
    const response = await this.callEmpty<StringValue>(this.client.getCurrentVersion);
    return response.getValue();
  }

  public async setDnsOptions(dns: IDnsOptions): Promise<void> {
    const dnsOptions = new grpcTypes.DnsOptions();

    const defaultOptions = new grpcTypes.DefaultDnsOptions();
    defaultOptions.setBlockAds(dns.defaultOptions.blockAds);
    defaultOptions.setBlockTrackers(dns.defaultOptions.blockTrackers);
    defaultOptions.setBlockMalware(dns.defaultOptions.blockMalware);
    dnsOptions.setDefaultOptions(defaultOptions);

    const customOptions = new grpcTypes.CustomDnsOptions();
    customOptions.setAddressesList(dns.customOptions.addresses);
    dnsOptions.setCustomOptions(customOptions);

    if (dns.state === 'custom') {
      dnsOptions.setState(grpcTypes.DnsOptions.DnsState.CUSTOM);
    } else {
      dnsOptions.setState(grpcTypes.DnsOptions.DnsState.DEFAULT);
    }

    await this.call<grpcTypes.DnsOptions, Empty>(this.client.setDnsOptions, dnsOptions);
  }

  public async getVersionInfo(): Promise<IAppVersionInfo> {
    const response = await this.callEmpty<grpcTypes.AppVersionInfo>(this.client.getVersionInfo);
    return response.toObject();
  }

  public async addSplitTunnelingApplication(path: string): Promise<void> {
    await this.callString(this.client.addSplitTunnelApp, path);
  }

  public async removeSplitTunnelingApplication(path: string): Promise<void> {
    await this.callString(this.client.removeSplitTunnelApp, path);
  }

  public async setSplitTunnelingState(enabled: boolean): Promise<void> {
    await this.callBool(this.client.setSplitTunnelState, enabled);
  }

  public async checkVolumes(): Promise<void> {
    await this.callEmpty(this.client.checkVolumes);
  }

  public async getDevice(): Promise<DeviceConfig> {
    try {
      const response = await this.callEmpty<grpcTypes.DeviceConfig>(this.client.getDevice);
      return convertFromDeviceConfig(response);
    } catch (e) {
      const error = e as grpc.ServiceError;
      if (error.code === grpc.status.NOT_FOUND) {
        return undefined;
      } else {
        throw error;
      }
    }
  }

  public async listDevices(accountToken: AccountToken): Promise<Array<IDevice>> {
    const response = await this.callString<grpcTypes.DeviceList>(
      this.client.listDevices,
      accountToken,
    );

    return response.getDevicesList().map(convertFromDevice);
  }

  public async removeDevice(deviceRemoval: IDeviceRemoval): Promise<void> {
    const grpcDeviceRemoval = new grpcTypes.DeviceRemoval();
    grpcDeviceRemoval.setAccountToken(deviceRemoval.accountToken);
    grpcDeviceRemoval.setDeviceId(deviceRemoval.deviceId);

    await this.call<grpcTypes.DeviceRemoval, Empty>(this.client.removeDevice, grpcDeviceRemoval);
  }

  private subscriptionId(): number {
    const current = this.nextSubscriptionId;
    this.nextSubscriptionId += 1;
    return current;
  }

  private deadlineFromNow() {
    return Date.now() + NETWORK_CALL_TIMEOUT;
  }

  private channelStateTimeout(): number {
    return Date.now() + CHANNEL_STATE_TIMEOUT;
  }

  private callEmpty<R>(fn: CallFunctionArgument<Empty, R>): Promise<R> {
    return this.call<Empty, R>(fn, new Empty());
  }

  private callString<R>(fn: CallFunctionArgument<StringValue, R>, value?: string): Promise<R> {
    const googleString = new StringValue();

    if (value !== undefined) {
      googleString.setValue(value);
    }

    return this.call<StringValue, R>(fn, googleString);
  }

  private callBool<R>(fn: CallFunctionArgument<BoolValue, R>, value?: boolean): Promise<R> {
    const googleBool = new BoolValue();

    if (value !== undefined) {
      googleBool.setValue(value);
    }

    return this.call<BoolValue, R>(fn, googleBool);
  }

  private callNumber<R>(fn: CallFunctionArgument<UInt32Value, R>, value?: number): Promise<R> {
    const googleNumber = new UInt32Value();

    if (value !== undefined) {
      googleNumber.setValue(value);
    }

    return this.call<UInt32Value, R>(fn, googleNumber);
  }

  private call<T, R>(fn: CallFunctionArgument<T, R>, arg: T): Promise<R> {
    if (fn && this.isConnected) {
      return promisify<T, R>(fn.bind(this.client))(arg);
    } else {
      throw noConnectionError;
    }
  }

  private removeSubscription(id: number) {
    const subscription = this.subscriptions.get(id);
    if (subscription !== undefined) {
      this.subscriptions.delete(id);
      subscription.removeAllListeners('data');
      subscription.removeAllListeners('error');

      subscription.on('error', (e) => {
        const error = e as grpc.ServiceError;
        if (error.code !== grpc.status.CANCELLED) {
          throw error;
        }
      });
      // setImmediate is required due to https://github.com/grpc/grpc-node/issues/1464. Should be
      // possible to remove it again after upgrading to Electron 16 which is using a node version
      // where this is fixed.
      setImmediate(() => subscription.cancel());
    }
  }

  private channelOptions(): grpc.ClientOptions {
    /* eslint-disable @typescript-eslint/naming-convention */
    return {
      'grpc.max_reconnect_backoff_ms': 3000,
      'grpc.initial_reconnect_backoff_ms': 3000,
      'grpc.keepalive_time_ms': Math.pow(2, 30),
      'grpc.keepalive_timeout_ms': Math.pow(2, 30),
    };
    /* eslint-enable @typescript-eslint/naming-convention */
  }

  private connectivityChangeCallback(timeoutErr?: Error) {
    const channel = this.client.getChannel();
    const currentState = channel?.getConnectivityState(true);
    log.verbose(`GRPC Channel connectivity state changed to ${currentState}`);
    if (channel) {
      if (timeoutErr) {
        this.setChannelCallback(currentState);
        return;
      }
      const wasConnected = this.isConnected;
      if (this.channelDisconnected(currentState)) {
        this.connectionObservers.forEach((observer) => observer.onClose());
        this.isConnected = false;
        // Try and reconnect in case
        void this.connect().catch((error) => {
          log.error(`Failed to reconnect - ${error}`);
        });
        this.setChannelCallback(currentState);
      } else if (!wasConnected && currentState === grpc.connectivityState.READY) {
        this.isConnected = true;
        this.connectionObservers.forEach((observer) => observer.onOpen());
        this.setChannelCallback(currentState);
      }
    }
  }

  private channelDisconnected(state: grpc.connectivityState): boolean {
    return (
      (state === grpc.connectivityState.SHUTDOWN ||
        state === grpc.connectivityState.TRANSIENT_FAILURE ||
        state === grpc.connectivityState.IDLE) &&
      this.isConnected
    );
  }

  private setChannelCallback(currentState?: grpc.connectivityState) {
    const channel = this.client.getChannel();
    if (currentState === undefined && channel) {
      currentState = channel?.getConnectivityState(false);
    }
    if (currentState) {
      channel.watchConnectivityState(currentState, this.channelStateTimeout(), (error) =>
        this.connectivityChangeCallback(error),
      );
    }
  }

  // Since grpc.Channel.watchConnectivityState() isn't always running as intended, whenever the
  // client fails to connect at first, `ensureConnectivity()` should be called so that it tries to
  // check the connectivity state and nudge the client into connecting.
  // `grpc.Channel.getConnectivityState(true)` should make it attempt to connect.
  private ensureConnectivity() {
    this.reconnectionTimeout = setTimeout(() => {
      const lastState = this.client.getChannel().getConnectivityState(true);
      if (this.channelDisconnected(lastState)) {
        this.connectionObservers.forEach((observer) => observer.onClose());
        this.isConnected = false;
      }
      if (!this.isConnected) {
        void this.connect().catch((error) => {
          log.error(`Failed to reconnect - ${error}`);
        });
      }
    }, 3000);
  }
}

function liftConstraint<T>(constraint: Constraint<T> | undefined): T | undefined {
  if (constraint !== undefined && constraint !== 'any') {
    return constraint.only;
  }
  return undefined;
}

function convertFromRelayListCountry(
  country: grpcTypes.RelayListCountry.AsObject,
): IRelayListCountry {
  return {
    ...country,
    cities: country.citiesList.map(convertFromRelayListCity),
  };
}

function convertFromRelayListCity(city: grpcTypes.RelayListCity.AsObject): IRelayListCity {
  return {
    ...city,
    relays: city.relaysList.map(convertFromRelayListRelay),
  };
}

function convertFromRelayListRelay(relay: grpcTypes.Relay.AsObject): IRelayListHostname {
  return {
    ...relay,
    tunnels: relay.tunnels && {
      ...relay.tunnels,
      openvpn: relay.tunnels.openvpnList.map(convertFromOpenvpnList),
      wireguard: relay.tunnels.wireguardList.map(convertFromWireguardList),
    },
    bridges: relay.bridges && {
      shadowsocks: relay.bridges.shadowsocksList.map(convertFromShadowsocksList),
    },
  };
}

function convertFromOpenvpnList(
  openvpn: grpcTypes.OpenVpnEndpointData.AsObject,
): IOpenVpnTunnelData {
  return {
    ...openvpn,
    protocol: convertFromTransportProtocol(openvpn.protocol),
  };
}

function convertFromWireguardList(
  wireguard: grpcTypes.WireguardEndpointData.AsObject,
): IWireguardTunnelData {
  return {
    ...wireguard,
    portRanges: wireguard.portRangesList,
    publicKey: convertFromWireguardKey(wireguard.publicKey),
  };
}

function convertFromWireguardKey(publicKey: Uint8Array | string): string {
  if (typeof publicKey === 'string') {
    return publicKey;
  }
  return Buffer.from(publicKey).toString('base64');
}

function convertFromShadowsocksList(
  shadowsocks: grpcTypes.ShadowsocksEndpointData.AsObject,
): IShadowsocksEndpointData {
  return {
    ...shadowsocks,
    protocol: convertFromTransportProtocol(shadowsocks.protocol),
  };
}

function convertFromTransportProtocol(protocol: grpcTypes.TransportProtocol): RelayProtocol {
  const protocolMap: Record<grpcTypes.TransportProtocol, RelayProtocol> = {
    [grpcTypes.TransportProtocol.TCP]: 'tcp',
    [grpcTypes.TransportProtocol.UDP]: 'udp',
  };
  return protocolMap[protocol];
}

function convertFromTunnelState(tunnelState: grpcTypes.TunnelState): TunnelState | undefined {
  const tunnelStateObject = tunnelState.toObject();
  switch (tunnelState.getStateCase()) {
    case grpcTypes.TunnelState.StateCase.STATE_NOT_SET:
      return undefined;
    case grpcTypes.TunnelState.StateCase.DISCONNECTED:
      return { state: 'disconnected' };
    case grpcTypes.TunnelState.StateCase.DISCONNECTING: {
      const detailsMap: Record<grpcTypes.AfterDisconnect, AfterDisconnect> = {
        [grpcTypes.AfterDisconnect.NOTHING]: 'nothing',
        [grpcTypes.AfterDisconnect.BLOCK]: 'block',
        [grpcTypes.AfterDisconnect.RECONNECT]: 'reconnect',
      };
      return (
        tunnelStateObject.disconnecting && {
          state: 'disconnecting',
          details: detailsMap[tunnelStateObject.disconnecting.afterDisconnect],
        }
      );
    }
    case grpcTypes.TunnelState.StateCase.ERROR:
      return (
        tunnelStateObject.error?.errorState && {
          state: 'error',
          details: convertFromTunnelStateError(tunnelStateObject.error.errorState),
        }
      );
    case grpcTypes.TunnelState.StateCase.CONNECTING:
      return {
        state: 'connecting',
        details:
          tunnelStateObject.connecting?.relayInfo &&
          convertFromTunnelStateRelayInfo(tunnelStateObject.connecting.relayInfo),
      };
    case grpcTypes.TunnelState.StateCase.CONNECTED: {
      const relayInfo =
        tunnelStateObject.connected?.relayInfo &&
        convertFromTunnelStateRelayInfo(tunnelStateObject.connected.relayInfo);
      return (
        relayInfo && {
          state: 'connected',
          details: relayInfo,
        }
      );
    }
  }
}

function convertFromTunnelStateError(state: grpcTypes.ErrorState.AsObject): IErrorState {
  return {
    ...state,
    cause: convertFromTunnelStateErrorCause(state.cause, state),
    blockFailure: state.blockingError
      ? convertFromFirewallPolicyError(state.blockingError)
      : undefined,
  };
}

function convertFromTunnelStateErrorCause(
  cause: grpcTypes.ErrorState.Cause,
  state: grpcTypes.ErrorState.AsObject,
): ErrorStateCause {
  switch (cause) {
    case grpcTypes.ErrorState.Cause.IS_OFFLINE:
      return { reason: 'is_offline' };
    case grpcTypes.ErrorState.Cause.SET_DNS_ERROR:
      return { reason: 'set_dns_error' };
    case grpcTypes.ErrorState.Cause.IPV6_UNAVAILABLE:
      return { reason: 'ipv6_unavailable' };
    case grpcTypes.ErrorState.Cause.START_TUNNEL_ERROR:
      return { reason: 'start_tunnel_error' };
    case grpcTypes.ErrorState.Cause.SET_FIREWALL_POLICY_ERROR:
      return {
        reason: 'set_firewall_policy_error',
        details: convertFromFirewallPolicyError(state.policyError!),
      };
    case grpcTypes.ErrorState.Cause.AUTH_FAILED:
      return { reason: 'auth_failed', details: state.authFailReason };
    case grpcTypes.ErrorState.Cause.TUNNEL_PARAMETER_ERROR: {
      const parameterErrorMap: Record<
        grpcTypes.ErrorState.GenerationError,
        TunnelParameterError
      > = {
        [grpcTypes.ErrorState.GenerationError.NO_MATCHING_RELAY]: 'no_matching_relay',
        [grpcTypes.ErrorState.GenerationError.NO_MATCHING_BRIDGE_RELAY]: 'no_matching_bridge_relay',
        [grpcTypes.ErrorState.GenerationError.NO_WIREGUARD_KEY]: 'no_wireguard_key',
        [grpcTypes.ErrorState.GenerationError.CUSTOM_TUNNEL_HOST_RESOLUTION_ERROR]:
          'custom_tunnel_host_resultion_error',
      };
      return { reason: 'tunnel_parameter_error', details: parameterErrorMap[state.parameterError] };
    }
    case grpcTypes.ErrorState.Cause.SPLIT_TUNNEL_ERROR:
      return { reason: 'split_tunnel_error' };
    case grpcTypes.ErrorState.Cause.VPN_PERMISSION_DENIED:
      // VPN_PERMISSION_DENIED is only ever created on Android
      throw invalidErrorStateCause;
  }
}

function convertFromFirewallPolicyError(
  error: grpcTypes.ErrorState.FirewallPolicyError.AsObject,
): FirewallPolicyError {
  switch (error.type) {
    case grpcTypes.ErrorState.FirewallPolicyError.ErrorType.GENERIC:
      return { reason: 'generic' };
    case grpcTypes.ErrorState.FirewallPolicyError.ErrorType.LOCKED: {
      const pid = error.lockPid;
      const name = error.lockName;
      return { reason: 'locked', details: pid && name ? { pid, name } : undefined };
    }
  }
}

function convertFromTunnelStateRelayInfo(
  state: grpcTypes.TunnelStateRelayInfo.AsObject,
): ITunnelStateRelayInfo | undefined {
  if (state.tunnelEndpoint) {
    return {
      ...state,
      endpoint: {
        ...state.tunnelEndpoint,
        tunnelType: convertFromTunnelType(state.tunnelEndpoint.tunnelType),
        protocol: convertFromTransportProtocol(state.tunnelEndpoint.protocol),
        proxy: state.tunnelEndpoint.proxy && convertFromProxyEndpoint(state.tunnelEndpoint.proxy),
        entryEndpoint:
          state.tunnelEndpoint.entryEndpoint &&
          convertFromEntryEndpoint(state.tunnelEndpoint.entryEndpoint),
      },
    };
  }
  return undefined;
}

function convertFromTunnelType(tunnelType: grpcTypes.TunnelType): TunnelType {
  const tunnelTypeMap: Record<grpcTypes.TunnelType, TunnelType> = {
    [grpcTypes.TunnelType.WIREGUARD]: 'wireguard',
    [grpcTypes.TunnelType.OPENVPN]: 'openvpn',
  };

  return tunnelTypeMap[tunnelType];
}

function convertFromProxyEndpoint(proxyEndpoint: grpcTypes.ProxyEndpoint.AsObject): IProxyEndpoint {
  const proxyTypeMap: Record<grpcTypes.ProxyType, ProxyType> = {
    [grpcTypes.ProxyType.CUSTOM]: 'custom',
    [grpcTypes.ProxyType.SHADOWSOCKS]: 'shadowsocks',
  };

  return {
    ...proxyEndpoint,
    protocol: convertFromTransportProtocol(proxyEndpoint.protocol),
    proxyType: proxyTypeMap[proxyEndpoint.proxyType],
  };
}

function convertFromEntryEndpoint(entryEndpoint: grpcTypes.Endpoint.AsObject) {
  return {
    address: entryEndpoint.address,
    transportProtocol: convertFromTransportProtocol(entryEndpoint.protocol),
  };
}

function convertFromSettings(settings: grpcTypes.Settings): ISettings | undefined {
  const settingsObject = settings.toObject();
  const bridgeState = convertFromBridgeState(settingsObject.bridgeState!.state!);
  const relaySettings = convertFromRelaySettings(settings.getRelaySettings())!;
  const bridgeSettings = convertFromBridgeSettings(settingsObject.bridgeSettings!);
  const tunnelOptions = convertFromTunnelOptions(settingsObject.tunnelOptions!);
  const splitTunnel = settingsObject.splitTunnel ?? { enableExclusions: false, appsList: [] };
  return {
    ...settings.toObject(),
    bridgeState,
    relaySettings,
    bridgeSettings,
    tunnelOptions,
    splitTunnel,
  };
}

function convertFromBridgeState(bridgeState: grpcTypes.BridgeState.State): BridgeState {
  const bridgeStateMap: Record<grpcTypes.BridgeState.State, BridgeState> = {
    [grpcTypes.BridgeState.State.AUTO]: 'auto',
    [grpcTypes.BridgeState.State.ON]: 'on',
    [grpcTypes.BridgeState.State.OFF]: 'off',
  };

  return bridgeStateMap[bridgeState];
}

function convertFromRelaySettings(
  relaySettings?: grpcTypes.RelaySettings,
): RelaySettings | undefined {
  if (relaySettings) {
    switch (relaySettings.getEndpointCase()) {
      case grpcTypes.RelaySettings.EndpointCase.ENDPOINT_NOT_SET:
        return undefined;
      case grpcTypes.RelaySettings.EndpointCase.CUSTOM: {
        const custom = relaySettings.getCustom()?.toObject();
        const config = relaySettings.getCustom()?.getConfig();
        const connectionConfig = config && convertFromConnectionConfig(config);
        return (
          custom &&
          connectionConfig && {
            customTunnelEndpoint: {
              ...custom,
              config: connectionConfig,
            },
          }
        );
      }
      case grpcTypes.RelaySettings.EndpointCase.NORMAL: {
        const normal = relaySettings.getNormal()!;
        const grpcLocation = normal.getLocation();
        const location = grpcLocation
          ? { only: convertFromLocation(grpcLocation.toObject()) }
          : 'any';
        const tunnelProtocol = convertFromTunnelTypeConstraint(normal.getTunnelType()!);
        const providers = normal.getProvidersList();
        const openvpnConstraints = convertFromOpenVpnConstraints(normal.getOpenvpnConstraints()!);
        const wireguardConstraints = convertFromWireguardConstraints(
          normal.getWireguardConstraints()!,
        );

        return {
          normal: {
            location,
            tunnelProtocol,
            providers,
            wireguardConstraints,
            openvpnConstraints,
          },
        };
      }
    }
  } else {
    return undefined;
  }
}

function convertFromBridgeSettings(
  bridgeSettings: grpcTypes.BridgeSettings.AsObject,
): BridgeSettings {
  const normalSettings = bridgeSettings.normal;
  if (normalSettings) {
    const grpcLocation = normalSettings.location;
    const location = grpcLocation ? { only: convertFromLocation(grpcLocation) } : 'any';
    const providers = normalSettings.providersList;
    return {
      normal: {
        location,
        providers,
      },
    };
  }

  const customSettings = (settings: ProxySettings): BridgeSettings => {
    return { custom: settings };
  };

  const localSettings = bridgeSettings.local;
  if (localSettings) {
    return customSettings({
      port: localSettings.port,
      peer: localSettings.peer,
    });
  }

  const remoteSettings = bridgeSettings.remote;
  if (remoteSettings) {
    return customSettings({
      address: remoteSettings.address,
      auth: remoteSettings.auth && { ...remoteSettings.auth },
    });
  }

  const shadowsocksSettings = bridgeSettings.shadowsocks!;
  return customSettings({
    peer: shadowsocksSettings.peer!,
    password: shadowsocksSettings.password!,
    cipher: shadowsocksSettings.cipher!,
  });
}

function convertFromConnectionConfig(
  connectionConfig: grpcTypes.ConnectionConfig,
): ConnectionConfig | undefined {
  const connectionConfigObject = connectionConfig.toObject();
  switch (connectionConfig.getConfigCase()) {
    case grpcTypes.ConnectionConfig.ConfigCase.CONFIG_NOT_SET:
      return undefined;
    case grpcTypes.ConnectionConfig.ConfigCase.WIREGUARD:
      return (
        connectionConfigObject.wireguard &&
        connectionConfigObject.wireguard.tunnel &&
        connectionConfigObject.wireguard.peer && {
          wireguard: {
            ...connectionConfigObject.wireguard,
            tunnel: {
              privateKey: convertFromWireguardKey(
                connectionConfigObject.wireguard.tunnel.privateKey,
              ),
              addresses: connectionConfigObject.wireguard.tunnel.addressesList,
            },
            peer: {
              ...connectionConfigObject.wireguard.peer,
              addresses: connectionConfigObject.wireguard.peer.allowedIpsList,
              publicKey: convertFromWireguardKey(connectionConfigObject.wireguard.peer.publicKey),
            },
          },
        }
      );
    case grpcTypes.ConnectionConfig.ConfigCase.OPENVPN: {
      const [ip, port] = connectionConfigObject.openvpn!.address.split(':');
      return {
        openvpn: {
          ...connectionConfigObject.openvpn!,
          endpoint: {
            ip,
            port: parseInt(port, 10),
            protocol: convertFromTransportProtocol(connectionConfigObject.openvpn!.protocol),
          },
        },
      };
    }
  }
}

function convertFromLocation(location: grpcTypes.RelayLocation.AsObject): RelayLocation {
  if (location.hostname) {
    return { hostname: [location.country, location.city, location.hostname] };
  }
  if (location.city) {
    return { city: [location.country, location.city] };
  }

  return { country: location.country };
}

function convertFromTunnelOptions(tunnelOptions: grpcTypes.TunnelOptions.AsObject): ITunnelOptions {
  return {
    openvpn: {
      mssfix: tunnelOptions.openvpn!.mssfix,
    },
    wireguard: {
      mtu: tunnelOptions.wireguard!.mtu,
    },
    generic: {
      enableIpv6: tunnelOptions.generic!.enableIpv6,
    },
    dns: {
      state:
        tunnelOptions.dnsOptions?.state === grpcTypes.DnsOptions.DnsState.CUSTOM
          ? 'custom'
          : 'default',
      defaultOptions: {
        blockAds: tunnelOptions.dnsOptions?.defaultOptions?.blockAds ?? false,
        blockTrackers: tunnelOptions.dnsOptions?.defaultOptions?.blockTrackers ?? false,
        blockMalware: tunnelOptions.dnsOptions?.defaultOptions?.blockMalware ?? false,
      },
      customOptions: {
        addresses: tunnelOptions.dnsOptions?.customOptions?.addressesList ?? [],
      },
    },
  };
}

function convertFromDaemonEvent(data: grpcTypes.DaemonEvent): DaemonEvent {
  const tunnelState = data.getTunnelState();
  if (tunnelState !== undefined) {
    return { tunnelState: convertFromTunnelState(tunnelState)! };
  }

  const settings = data.getSettings();
  if (settings !== undefined) {
    return { settings: convertFromSettings(settings)! };
  }

  const relayList = data.getRelayList();
  if (relayList !== undefined) {
    return {
      relayList: {
        countries: relayList
          .getCountriesList()
          ?.map((country: grpcTypes.RelayListCountry) =>
            convertFromRelayListCountry(country.toObject()),
          ),
      },
    };
  }

  const deviceConfig = data.getDevice();
  if (deviceConfig !== undefined) {
    return { device: convertFromDeviceEvent(deviceConfig) };
  }

  const deviceRemoval = data.getRemoveDevice();
  if (deviceRemoval !== undefined) {
    return { deviceRemoval: convertFromDeviceRemoval(deviceRemoval) };
  }

  const versionInfo = data.getVersionInfo();
  if (versionInfo !== undefined) {
    return { appVersionInfo: versionInfo.toObject() };
  }

  // Handle unknown daemon events
  const keys = Object.entries(data.toObject())
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  throw new Error(`Unknown daemon event received containing ${keys}`);
}

function convertFromOpenVpnConstraints(
  constraints: grpcTypes.OpenvpnConstraints,
): IOpenVpnConstraints {
  const transportPort = convertFromConstraint(constraints.getPort());
  if (transportPort !== 'any' && 'only' in transportPort) {
    const port = convertFromConstraint(transportPort.only.getPort());
    let protocol: Constraint<RelayProtocol> = 'any';
    switch (transportPort.only.getProtocol()) {
      case grpcTypes.TransportProtocol.TCP:
        protocol = { only: 'tcp' };
        break;
      case grpcTypes.TransportProtocol.UDP:
        protocol = { only: 'udp' };
        break;
    }
    return { port, protocol };
  }
  return { port: 'any', protocol: 'any' };
}

function convertFromWireguardConstraints(
  constraints: grpcTypes.WireguardConstraints,
): IWireguardConstraints {
  const result: IWireguardConstraints = {
    port: 'any',
    ipVersion: 'any',
    useMultihop: constraints.getUseMultihop(),
    entryLocation: 'any',
  };

  const port = constraints.getPort()?.getPort();
  if (port) {
    result.port = { only: port };
  }

  const ipVersion = constraints.getIpVersion()?.getProtocol();
  switch (ipVersion) {
    case grpcTypes.IpVersion.V4:
      result.ipVersion = { only: 'ipv4' };
      break;
    case grpcTypes.IpVersion.V6:
      result.ipVersion = { only: 'ipv6' };
      break;
  }

  const entryLocation = constraints.getEntryLocation();
  if (entryLocation) {
    result.entryLocation = { only: convertFromLocation(entryLocation.toObject()) };
  }

  return result;
}

function convertFromTunnelTypeConstraint(
  constraint: grpcTypes.TunnelTypeConstraint | undefined,
): Constraint<TunnelProtocol> {
  switch (constraint?.getTunnelType()) {
    case grpcTypes.TunnelType.WIREGUARD: {
      return { only: 'wireguard' };
    }
    case grpcTypes.TunnelType.OPENVPN: {
      return { only: 'openvpn' };
    }
    default: {
      return 'any';
    }
  }
}

function convertFromConstraint<T>(value: T | undefined): Constraint<T> {
  if (value) {
    return { only: value };
  } else {
    return 'any';
  }
}

function convertToNormalBridgeSettings(
  constraints: IBridgeConstraints,
): grpcTypes.BridgeSettings.BridgeConstraints {
  const normalBridgeSettings = new grpcTypes.BridgeSettings.BridgeConstraints();
  normalBridgeSettings.setLocation(convertToLocation(liftConstraint(constraints.location)));
  normalBridgeSettings.setProvidersList(constraints.providers);

  return normalBridgeSettings;
}

function convertToLocation(
  constraint: RelayLocation | undefined,
): grpcTypes.RelayLocation | undefined {
  const location = new grpcTypes.RelayLocation();
  if (constraint && 'hostname' in constraint) {
    const [countryCode, cityCode, hostname] = constraint.hostname;
    location.setCountry(countryCode);
    location.setCity(cityCode);
    location.setHostname(hostname);
    return location;
  } else if (constraint && 'city' in constraint) {
    location.setCountry(constraint.city[0]);
    location.setCity(constraint.city[1]);
    return location;
  } else if (constraint && 'country' in constraint) {
    location.setCountry(constraint.country);
    return location;
  } else {
    return undefined;
  }
}

function convertToTunnelTypeConstraint(
  constraint: Constraint<TunnelType>,
): grpcTypes.TunnelTypeConstraint | undefined {
  const grpcConstraint = new grpcTypes.TunnelTypeConstraint();

  if (constraint !== undefined && constraint !== 'any' && 'only' in constraint) {
    switch (constraint.only) {
      case 'wireguard':
        grpcConstraint.setTunnelType(grpcTypes.TunnelType.WIREGUARD);
        return grpcConstraint;
      case 'openvpn':
        grpcConstraint.setTunnelType(grpcTypes.TunnelType.OPENVPN);
        return grpcConstraint;
    }
  }
  return undefined;
}

function convertToOpenVpnConstraints(
  constraints: Partial<IOpenVpnConstraints> | undefined,
): grpcTypes.OpenvpnConstraints | undefined {
  const openvpnConstraints = new grpcTypes.OpenvpnConstraints();
  if (constraints) {
    const protocol = liftConstraint(constraints.protocol);
    if (protocol) {
      const portConstraints = new grpcTypes.TransportPort();
      const port = liftConstraint(constraints.port);
      if (port) {
        portConstraints.setPort(port);
      }
      portConstraints.setProtocol(convertToTransportProtocol(protocol));
      openvpnConstraints.setPort(portConstraints);
    }
    return openvpnConstraints;
  }

  return undefined;
}

function convertToWireguardConstraints(
  constraint: Partial<IWireguardConstraints> | undefined,
): grpcTypes.WireguardConstraints | undefined {
  if (constraint) {
    const wireguardConstraints = new grpcTypes.WireguardConstraints();

    const port = liftConstraint(constraint.port);
    if (port) {
      const portConstraints = new grpcTypes.TransportPort();
      portConstraints.setPort(port);
      portConstraints.setProtocol(grpcTypes.TransportProtocol.UDP);
      wireguardConstraints.setPort(portConstraints);
    }

    const ipVersion = liftConstraint(constraint.ipVersion);
    if (ipVersion) {
      const ipVersionProtocol =
        ipVersion === 'ipv4' ? grpcTypes.IpVersion.V4 : grpcTypes.IpVersion.V6;
      const ipVersionConstraints = new grpcTypes.IpVersionConstraint();
      ipVersionConstraints.setProtocol(ipVersionProtocol);
      wireguardConstraints.setIpVersion(ipVersionConstraints);
    }

    if (constraint.useMultihop) {
      wireguardConstraints.setUseMultihop(constraint.useMultihop);
    }

    const entryLocation = liftConstraint(constraint.entryLocation);
    if (entryLocation) {
      const entryLocationConstraint = convertToLocation(entryLocation);
      wireguardConstraints.setEntryLocation(entryLocationConstraint);
    }

    return wireguardConstraints;
  }
  return undefined;
}

function convertToTransportProtocol(protocol: RelayProtocol): grpcTypes.TransportProtocol {
  switch (protocol) {
    case 'udp':
      return grpcTypes.TransportProtocol.UDP;
    case 'tcp':
      return grpcTypes.TransportProtocol.TCP;
  }
}

function convertFromDeviceEvent(deviceEvent: grpcTypes.DeviceEvent): IDeviceEvent {
  return {
    deviceConfig: convertFromDeviceConfig(deviceEvent.getDevice()),
    remote: deviceEvent.getRemote(),
  };
}

function convertFromDeviceConfig(deviceConfig?: grpcTypes.DeviceConfig): DeviceConfig {
  const device = deviceConfig?.getDevice();
  return (
    deviceConfig && {
      accountToken: deviceConfig.getAccountToken(),
      device: device ? convertFromDevice(device) : undefined,
    }
  );
}

function convertFromDeviceRemoval(deviceRemoval: grpcTypes.RemoveDeviceEvent): Array<IDevice> {
  return deviceRemoval.getNewDeviceListList().map(convertFromDevice);
}

function convertFromDevice(device: grpcTypes.Device): IDevice {
  const asObject = device.toObject();

  return {
    ...asObject,
    ports: asObject.portsList.map((port) => port.id),
  };
}

function ensureExists<T>(value: T | undefined, errorMessage: string): T {
  if (value) {
    return value;
  }
  throw new ResponseParseError(errorMessage);
}
