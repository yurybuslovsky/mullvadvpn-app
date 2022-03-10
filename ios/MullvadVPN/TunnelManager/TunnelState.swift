//
//  TunnelState.swift
//  TunnelState
//
//  Created by pronebird on 11/08/2021.
//  Copyright © 2021 Mullvad VPN AB. All rights reserved.
//

import Foundation

/// A struct describing the tunnel status.
struct TunnelStatus: Equatable, CustomStringConvertible {
    /// Whether netowork is reachable.
    var isNetworkReachable: Bool

    /// When the packet tunnel started connecting.
    var connectingDate: Date?

    /// Tunnel state.
    var state: TunnelState

    var description: String {
        var s = "\(state), network "

        if isNetworkReachable {
            s += "reachable"
        } else {
            s += "unreachable"
        }

        if let connectingDate = connectingDate {
            s += ", started connecting at \(connectingDate.logFormatDate())"
        }

        return s
    }

    /// Updates the tunnel status from packet tunnel status, mapping relay to tunnel state.
    mutating func update(from packetTunnelStatus: PacketTunnelStatus, mappingRelayToState mapper: (PacketTunnelRelay?) -> TunnelState?) {
        isNetworkReachable = packetTunnelStatus.isNetworkReachable
        connectingDate = packetTunnelStatus.connectingDate

        if let newState = mapper(packetTunnelStatus.tunnelRelay) {
            state = newState
        }
    }

    /// Resets all fields to their defaults and assigns the next tunnel state.
    mutating func reset(to newState: TunnelState) {
        isNetworkReachable = true
        connectingDate = nil
        state = newState
    }
}

/// An enum that describes the tunnel state.
enum TunnelState: Equatable, CustomStringConvertible {
    /// Pending reconnect after disconnect.
    case pendingReconnect

    /// Connecting the tunnel.
    case connecting(_ relay: PacketTunnelRelay?)

    /// Connected the tunnel
    case connected(PacketTunnelRelay)

    /// Disconnecting the tunnel
    case disconnecting(ActionAfterDisconnect)

    /// Disconnected the tunnel
    case disconnected

    /// Reconnecting the tunnel. Normally this state appears in response to changing the
    /// relay constraints and asking the running tunnel to reload the configuration.
    case reconnecting(_ relay: PacketTunnelRelay)

    var description: String {
        switch self {
        case .pendingReconnect:
            return "pending reconnect after disconnect"
        case .connecting(let tunnelRelay):
            if let tunnelRelay = tunnelRelay {
                return "connecting to \(tunnelRelay.hostname)"
            } else {
                return "connecting, fetching relay"
            }
        case .connected(let tunnelRelay):
            return "connected to \(tunnelRelay.hostname)"
        case .disconnecting(let actionAfterDisconnect):
            return "disconnecting and then \(actionAfterDisconnect)"
        case .disconnected:
            return "disconnected"
        case .reconnecting(let tunnelRelay):
            return "reconnecting to \(tunnelRelay.hostname)"
        }
    }
}

/// A enum that describes the action to perform after disconnect
enum ActionAfterDisconnect {
    /// Do nothing after disconnecting
    case nothing

    /// Reconnect after disconnecting
    case reconnect

    var description: String {
        switch self {
        case .nothing:
            return "do nothing"
        case .reconnect:
            return "reconnect"
        }
    }
}
