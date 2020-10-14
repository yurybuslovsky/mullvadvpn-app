//
//  IntentHandler.swift
//  MullvadVPNIntents
//
//  Created by pronebird on 13/10/2020.
//  Copyright © 2020 Mullvad VPN AB. All rights reserved.
//

import Intents
import NetworkExtension
import Logging

private struct IntentInitialization {
    static let once = IntentInitialization()

    init() {
        initLoggingSystem(bundleIdentifier: Bundle.main.bundleIdentifier!, rotateLog: false)
    }
}

class IntentHandler: INExtension {
    private let logger: Logger

    override init() {
        _ = IntentInitialization.once

        logger = Logger(label: "IntentHandler")

        super.init()
    }

    override func handler(for intent: INIntent) -> Any? {
        logger.info("Handle intent: \(intent)")

        if intent is ConnectVPNIntent {
            return ConnectVPNIntentHandler()
        } else if intent is DisconnectVPNIntent {
            return DisconnectVPNIntentHandler()
        } else {
            return nil
        }
    }

}

class ConnectVPNIntentHandler: NSObject, ConnectVPNIntentHandling {
    private let logger = Logger(label: "ConnectVPNIntentHandler")

    func handle(intent: ConnectVPNIntent, completion: @escaping (ConnectVPNIntentResponse) -> Void) {
        NETunnelProviderManager.loadAllFromPreferences { (tunnels, error) in
            if let error = error {
                self.logger.error("Failure to load preferences: \(error.localizedDescription)")

                completion(ConnectVPNIntentResponse(code: .cannotLoadTunnels, userActivity: nil))
            } else {
                if let tunnel = tunnels?.first {
                    do {
                        try tunnel.connection.startVPNTunnel()

                        completion(ConnectVPNIntentResponse(code: .success, userActivity: nil))
                    } catch {
                        self.logger.error("Failure to start the VPN tunnel: \(error.localizedDescription)")

                        completion(ConnectVPNIntentResponse(code: .failureToStartTunnel, userActivity: nil))
                    }
                } else {
                    self.logger.error("Failure to start the VPN tunnel: no tunnels have been found")

                    completion(ConnectVPNIntentResponse(code: .missingVPNConfiguration, userActivity: nil))
                }
            }
        }
    }
}

class DisconnectVPNIntentHandler: NSObject, DisconnectVPNIntentHandling {
    private let logger = Logger(label: "DisconnectVPNIntentHandler")

    func handle(intent: DisconnectVPNIntent, completion: @escaping (DisconnectVPNIntentResponse) -> Void) {
        NETunnelProviderManager.loadAllFromPreferences { (tunnels, error) in
            if let error = error {
                self.logger.error("Failure to load preferences: \(error.localizedDescription)")

                completion(DisconnectVPNIntentResponse(code: .cannotLoadTunnels, userActivity: nil))
            } else {
                if let tunnel = tunnels?.first {
                    // Disable on-demand when stopping the tunnel to prevent it from coming back up
                    tunnel.isOnDemandEnabled = false

                    tunnel.saveToPreferences { (error) in
                        if let error = error {
                            self.logger.error("Failure to save the VPN configuration: \(error.localizedDescription)")
                            completion(DisconnectVPNIntentResponse(code: .failureToSaveVPNConfiguration, userActivity: nil))
                        } else {
                            tunnel.connection.stopVPNTunnel()
                            completion(DisconnectVPNIntentResponse(code: .success, userActivity: nil))
                        }
                    }
                } else {
                    self.logger.error("Failure to stop the VPN tunnel: no tunnels have been found")

                    completion(DisconnectVPNIntentResponse(code: .missingVPNConfiguration, userActivity: nil))
                }
            }
        }
    }
}
