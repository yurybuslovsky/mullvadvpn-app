//
//  TunnelState.swift
//  TunnelState
//
//  Created by pronebird on 11/08/2021.
//  Copyright © 2021 Mullvad VPN AB. All rights reserved.
//

import Foundation

/// A enum that describes the tunnel state
enum TunnelState: Equatable, CustomStringConvertible {
    /// Pending reconnect after disconnect.
    case pendingReconnect

    /// Connecting the tunnel.
    case connecting(_ relay: PacketTunnelRelay?, _ reconnectAttemptDate: Date?)

    /// Connected the tunnel
    case connected(PacketTunnelRelay)

    /// Disconnecting the tunnel
    case disconnecting(ActionAfterDisconnect)

    /// Disconnected the tunnel
    case disconnected

    /// Reconnecting the tunnel. Normally this state appears in response to changing the
    /// relay constraints and asking the running tunnel to reload the configuration.
    case reconnecting(_ relay: PacketTunnelRelay, _ reconnectAttemptDate: Date?)

    var description: String {
        switch self {
        case .pendingReconnect:
            return "pending reconnect after disconnect"
        case .connecting(let tunnelRelay, _):
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
        case .reconnecting(let tunnelRelay, _):
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
