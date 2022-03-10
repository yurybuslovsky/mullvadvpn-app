//
//  SimulatorTunnelProvider.swift
//  MullvadVPN
//
//  Created by pronebird on 05/02/2020.
//  Copyright © 2020 Mullvad VPN AB. All rights reserved.
//

import Foundation
import NetworkExtension

// MARK: - Formal conformances

protocol VPNConnectionProtocol: NSObject {
    var status: NEVPNStatus { get }

    func startVPNTunnel() throws
    func startVPNTunnel(options: [String: NSObject]?) throws
    func stopVPNTunnel()
}

protocol VPNTunnelProviderSessionProtocol {
    func sendProviderMessage(_ messageData: Data, responseHandler: ((Data?) -> Void)?) throws
}

protocol VPNTunnelProviderManagerProtocol: Equatable {
    associatedtype SelfType: VPNTunnelProviderManagerProtocol
    associatedtype ConnectionType: VPNConnectionProtocol

    var isEnabled: Bool { get set }
    var protocolConfiguration: NEVPNProtocol? { get set }
    var localizedDescription: String? { get set }
    var connection: ConnectionType { get }

    init()

    func loadFromPreferences(completionHandler: @escaping (Error?) -> Void)
    func saveToPreferences(completionHandler: ((Error?) -> Void)?)
    func removeFromPreferences(completionHandler: ((Error?) -> Void)?)

    static func loadAllFromPreferences(completionHandler: @escaping ([SelfType]?, Error?) -> Void)
}

extension NEVPNConnection: VPNConnectionProtocol {}
extension NETunnelProviderSession: VPNTunnelProviderSessionProtocol {}
extension NETunnelProviderManager: VPNTunnelProviderManagerProtocol {}

#if targetEnvironment(simulator)

// MARK: - NEPacketTunnelProvider stubs

class SimulatorTunnelProviderDelegate {
    fileprivate(set) var connection: SimulatorVPNConnection?

    var protocolConfiguration: NEVPNProtocol {
        return connection?.protocolConfiguration ?? NEVPNProtocol()
    }

    var reasserting: Bool {
        get {
            return connection?.reasserting ?? false
        }
        set {
            connection?.reasserting = newValue
        }
    }

    func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        completionHandler(nil)
    }

    func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        completionHandler?(nil)
    }
}

class SimulatorTunnelProvider {
    static let shared = SimulatorTunnelProvider()

    private let lock = NSLock()
    private var _delegate: SimulatorTunnelProviderDelegate?

    var delegate: SimulatorTunnelProviderDelegate! {
        get {
            lock.lock()
            defer { lock.unlock() }

            return _delegate
        }
        set {
            lock.lock()
            _delegate = newValue
            lock.unlock()
        }
    }

    private init() {}

    fileprivate func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)? = nil) {
        self.delegate.handleAppMessage(messageData, completionHandler: completionHandler)
    }
}

// MARK: - NEVPNConnection stubs

class SimulatorVPNConnection: NSObject, VPNConnectionProtocol {
    // Protocol configuration is automatically synced by `SimulatorTunnelInfo`
    fileprivate var protocolConfiguration = NEVPNProtocol()

    private let lock = NSRecursiveLock()

    private var _status: NEVPNStatus = .disconnected
    private(set) var status: NEVPNStatus {
        get {
            lock.lock()
            defer { lock.unlock() }
            
            return _status
        }
        set {
            lock.lock()
            defer { lock.unlock() }

            if _status != newValue {
                _status = newValue

                // Send notification while holding the lock. This should enable the receiver
                // to fetch the `SimulatorVPNConnection.status` before it changes.
                postStatusDidChangeNotification()
            }
        }
    }

    private var statusBeforeReasserting: NEVPNStatus?
    private var _reasserting = false
    var reasserting: Bool {
        get {
            lock.lock()
            defer { lock.unlock() }

            return _reasserting
        }
        set {
            lock.lock()

            if _reasserting != newValue {
                _reasserting = newValue

                if newValue {
                    statusBeforeReasserting = status
                    status = .reasserting
                } else if let newStatus = statusBeforeReasserting {
                    status = newStatus
                    statusBeforeReasserting = nil
                }
            }

            lock.unlock()
        }
    }

    func startVPNTunnel() throws {
        try startVPNTunnel(options: nil)
    }

    func startVPNTunnel(options: [String: NSObject]?) throws {
        SimulatorTunnelProvider.shared.delegate.connection = self

        status = .connecting

        SimulatorTunnelProvider.shared.delegate.startTunnel(options: options) { (error) in
            if error == nil {
                self.status = .connected
            } else {
                self.status = .disconnected
            }
        }
    }

    func stopVPNTunnel() {
        status = .disconnecting

        SimulatorTunnelProvider.shared.delegate.stopTunnel(with: .userInitiated) {
            self.status = .disconnected
        }
    }

    private func postStatusDidChangeNotification() {
        NotificationCenter.default.post(name: .NEVPNStatusDidChange, object: self)
    }
}

// MARK: - NETunnelProviderSession stubs

class SimulatorTunnelProviderSession: SimulatorVPNConnection, VPNTunnelProviderSessionProtocol {

    func sendProviderMessage(_ messageData: Data, responseHandler: ((Data?) -> Void)?) throws {
        SimulatorTunnelProvider.shared.handleAppMessage(messageData, completionHandler: responseHandler)
    }

}

// MARK: - NETunnelProviderManager stubs

/// A mock struct for tunnel configuration and connection
private struct SimulatorTunnelInfo {
    /// A unique identifier for the configuration
    var identifier = UUID().uuidString

    /// An associated VPN connection.
    /// Intentionally initialized with a `SimulatorTunnelProviderSession` subclass which
    /// implements the necessary protocol
    var connection: SimulatorVPNConnection = SimulatorTunnelProviderSession()

    /// Whether configuration is enabled
    var isEnabled = false

    /// Whether on-demand VPN is enabled
    var isOnDemandEnabled = false

    /// On-demand VPN rules
    var onDemandRules = [NEOnDemandRule]()

    /// Protocol configuration
    var protocolConfiguration: NEVPNProtocol? {
        didSet {
            self.connection.protocolConfiguration = protocolConfiguration ?? NEVPNProtocol()
        }
    }

    /// Tunnel description
    var localizedDescription: String?

    /// Designated initializer
    init() {}
}

class SimulatorTunnelProviderManager: VPNTunnelProviderManagerProtocol, Equatable {

    static let tunnelsLock = NSRecursiveLock()
    fileprivate static var tunnels = [SimulatorTunnelInfo]()

    private let lock = NSLock()
    private var tunnelInfo: SimulatorTunnelInfo
    private var identifier: String {
        lock.lock()
        defer { lock.unlock() }

        return tunnelInfo.identifier
    }

    var isOnDemandEnabled: Bool {
        get {
            lock.lock()
            defer { lock.unlock() }

            return tunnelInfo.isOnDemandEnabled
        }
        set {
            lock.lock()
            tunnelInfo.isOnDemandEnabled = newValue
            lock.unlock()
        }
    }

    var onDemandRules: [NEOnDemandRule] {
        get {
            lock.lock()
            defer { lock.unlock() }

            return tunnelInfo.onDemandRules
        }
        set {
            lock.lock()
            tunnelInfo.onDemandRules = newValue
            lock.unlock()
        }
    }

    var isEnabled: Bool {
        get {
            lock.lock()
            defer { lock.unlock() }

            return tunnelInfo.isEnabled
        }
        set {
            lock.lock()
            tunnelInfo.isEnabled = newValue
            lock.unlock()
        }
    }

    var protocolConfiguration: NEVPNProtocol? {
        get {
            lock.lock()
            defer { lock.unlock() }

            return tunnelInfo.protocolConfiguration
        }
        set {
            lock.lock()
            tunnelInfo.protocolConfiguration = newValue
            lock.unlock()
        }
    }

    var localizedDescription: String? {
        get {
            lock.lock()
            defer { lock.unlock() }

            return tunnelInfo.localizedDescription
        }
        set {
            lock.lock()
            tunnelInfo.localizedDescription = newValue
            lock.unlock()
        }
    }

    var connection: SimulatorVPNConnection {
        lock.lock()
        defer { lock.unlock() }

        return tunnelInfo.connection
    }

    static func loadAllFromPreferences(completionHandler: ([SimulatorTunnelProviderManager]?, Error?) -> Void) {
        Self.tunnelsLock.lock()
        let tunnelProviders = tunnels.map { tunnelInfo in
            return SimulatorTunnelProviderManager(tunnelInfo: tunnelInfo)
        }
        Self.tunnelsLock.unlock()

        completionHandler(tunnelProviders, nil)
    }

    required convenience init() {
        self.init(tunnelInfo: SimulatorTunnelInfo())
    }

    private init(tunnelInfo: SimulatorTunnelInfo) {
        self.tunnelInfo = tunnelInfo
    }

    func loadFromPreferences(completionHandler: (Error?) -> Void) {
        var error: NEVPNError?

        Self.tunnelsLock.lock()

        if let savedTunnel = Self.tunnels.first(where: { $0.identifier == self.identifier }) {
            self.tunnelInfo = savedTunnel
        } else {
            error = NEVPNError(.configurationInvalid)
        }

        Self.tunnelsLock.unlock()

        completionHandler(error)
    }

    func saveToPreferences(completionHandler: ((Error?) -> Void)?) {
        Self.tunnelsLock.lock()

        if let index = Self.tunnels.firstIndex(where: { $0.identifier == self.identifier }) {
            Self.tunnels[index] = self.tunnelInfo
        } else {
            Self.tunnels.append(self.tunnelInfo)
        }

        Self.tunnelsLock.unlock()

        completionHandler?(nil)
    }

    func removeFromPreferences(completionHandler: ((Error?) -> Void)?) {
        var error: NEVPNError?

        Self.tunnelsLock.lock()

        if let index = Self.tunnels.firstIndex(where: { $0.identifier == self.identifier }) {
            Self.tunnels.remove(at: index)
        } else {
            error = NEVPNError(.configurationReadWriteFailed)
        }

        Self.tunnelsLock.unlock()

        completionHandler?(error)
    }

    static func == (lhs: SimulatorTunnelProviderManager, rhs: SimulatorTunnelProviderManager) -> Bool {
        lhs.identifier == rhs.identifier
    }

}

#endif
