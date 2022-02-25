//
//  Tunnel.swift
//  MullvadVPN
//
//  Created by pronebird on 25/02/2022.
//  Copyright © 2022 Mullvad VPN AB. All rights reserved.
//

import Foundation
import NetworkExtension

// Switch to stabs on simulator
#if targetEnvironment(simulator)
typealias TunnelProviderManagerType = SimulatorTunnelProviderManager
#else
typealias TunnelProviderManagerType = NETunnelProviderManager
#endif

/// Tunnel wrapper class.
class Tunnel {
    /// Tunnel provider manager.
    fileprivate let tunnelProvider: TunnelProviderManagerType

    /// Tunnel start date.
    ///
    /// It's set to `distantPast` when the VPN connection was established prior to being observed
    /// by the class.
    var startDate: Date? {
        lock.lock()
        defer { lock.unlock() }

        return _startDate
    }

    /// Tunnel connection status.
    var status: NEVPNStatus {
        return tunnelProvider.connection.status
    }

    /// Whether on-demand VPN is enabled.
    var isOnDemandEnabled: Bool {
        get {
            return tunnelProvider.isOnDemandEnabled
        }
        set {
            tunnelProvider.isOnDemandEnabled = newValue
        }
    }

    private let lock = NSLock()
    private var observerList = ObserverList<Tunnel.AnyStatusObserver>()
    
    private var _startDate: Date?

    init(tunnelProvider: TunnelProviderManagerType) {
        self.tunnelProvider = tunnelProvider

        NotificationCenter.default.addObserver(
            self, selector: #selector(handleVPNStatusChangeNotification(_:)),
            name: .NEVPNStatusDidChange,
            object: tunnelProvider.connection
        )

        handleVPNStatus(tunnelProvider.connection.status)
    }

    func start(options: [String: NSObject]?) throws {
        try tunnelProvider.connection.startVPNTunnel(options: options)
    }

    func stop() {
        tunnelProvider.connection.stopVPNTunnel()
    }

    func sendProviderMessage(_ messageData: Data, responseHandler: ((Data?) -> Void)?) throws {
        let session = tunnelProvider.connection as! VPNTunnelProviderSessionProtocol

        try session.sendProviderMessage(messageData, responseHandler: responseHandler)
    }

    func saveToPreferences(_ completion: @escaping (Error?) -> Void) {
        tunnelProvider.saveToPreferences(completionHandler: completion)
    }

    func removeFromPreferences(completion: @escaping (Error?) -> Void) {
        tunnelProvider.removeFromPreferences(completionHandler: completion)
    }

    func observeStatus(queue: DispatchQueue? = nil, body: @escaping (NEVPNStatus) -> Void) -> StatusObserver {
        let observer = StatusObserver(tunnel: self, queue: queue, body: body)

        observerList.append(AnyStatusObserver(observer))

        return observer
    }

    private func removeObserver(_ observer: StatusObserver) {
        observerList.remove(AnyStatusObserver(observer))
    }

    @objc private func handleVPNStatusChangeNotification(_ notification: Notification) {
        guard let connection = notification.object as? VPNConnectionProtocol else { return }

        handleVPNStatus(connection.status)

        observerList.forEach { observer in
            observer.receive(status: status)
        }
    }

    private func handleVPNStatus(_ status: NEVPNStatus) {
        switch status {
        case .connecting:
            lock.lock()
            _startDate = Date()
            lock.unlock()

        case .connected, .reasserting:
            lock.lock()
            if _startDate == nil {
                _startDate = .distantPast
            }
            lock.unlock()

        case .disconnecting:
            break

        case .disconnected, .invalid:
            lock.lock()
            _startDate = nil
            lock.unlock()

        @unknown default:
            break
        }
    }
}

extension Tunnel: Equatable {
    static func == (lhs: Tunnel, rhs: Tunnel) -> Bool {
        return lhs.tunnelProvider == rhs.tunnelProvider
    }
}

extension Tunnel {

    fileprivate class AnyStatusObserver: WeakObserverBox {
        weak var inner: StatusObserver?

        init(_ inner: StatusObserver) {
            self.inner = inner
        }

        func receive(status: NEVPNStatus) {
            inner?.receive(status: status)
        }

        static func == (lhs: Tunnel.AnyStatusObserver, rhs: Tunnel.AnyStatusObserver) -> Bool {
            return lhs.inner === rhs.inner
        }
    }

    class StatusObserver {
        private weak var tunnel: Tunnel?
        private let queue: DispatchQueue?
        private let body: (NEVPNStatus) -> Void

        fileprivate init(tunnel: Tunnel, queue: DispatchQueue?, body: @escaping (NEVPNStatus) -> Void) {
            self.tunnel = tunnel
            self.queue = queue
            self.body = body
        }

        fileprivate func receive(status: NEVPNStatus) {
            if let queue = queue {
                queue.async {
                    self.body(status)
                }
            } else {
                body(status)
            }
        }

        func invalidate() {
            tunnel?.removeObserver(self)
        }

        deinit {
            invalidate()
        }
    }
}
