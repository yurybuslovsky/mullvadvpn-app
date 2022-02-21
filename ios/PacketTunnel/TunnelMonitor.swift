//
//  TunnelMonitor.swift
//  PacketTunnel
//
//  Created by pronebird on 09/02/2022.
//  Copyright © 2022 Mullvad VPN AB. All rights reserved.
//

import Foundation
import NetworkExtension
import WireGuardKit
import Logging

protocol TunnelMonitorDelegate: AnyObject {
    func tunnelMonitor(_ tunnelMonitor: TunnelMonitor, connectionStatusDidChange status: TunnelMonitor.ConnectionStatus)
}

class TunnelMonitor {
    /// Interval at which to query the adapter for stats.
    static let statsQueryInterval: DispatchTimeInterval = .milliseconds(50)

    /// Interval for sending echo packets.
    static let pingInterval: DispatchTimeInterval = .seconds(3)

    /// Delay before sending the first echo packet.
    static let pingStartDelay: DispatchTimeInterval = .milliseconds(500)

    /// Interval after which connection is treated as being lost.
    static let connectionTimeout: TimeInterval = 15

    /// Tunnel connection status.
    enum ConnectionStatus {
        /// Connection established.
        case established

        /// Connection lost.
        case lost
    }

    private let stateLock = NSLock()
    private let adapter: WireGuardAdapter
    private let queue: DispatchQueue

    private var pinger: Pinger?
    private var networkBytesReceived: UInt64 = 0
    private var startDate: Date?
    private var connectionStatus: ConnectionStatus?

    private var logger = Logger(label: "TunnelMonitor")
    private var timer: DispatchSourceTimer?

    private weak var _delegate: TunnelMonitorDelegate?
    weak var delegate: TunnelMonitorDelegate? {
        set {
            stateLock.lock()
            _delegate = newValue
            stateLock.unlock()
        }
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _delegate
        }
    }

    init(queue: DispatchQueue, adapter: WireGuardAdapter) {
        self.queue = queue
        self.adapter = adapter
    }

    deinit {
        stop()
    }

    func start(address: IPv4Address) throws {
        stateLock.lock()
        defer { stateLock.unlock() }

        pinger?.stop()
        timer?.cancel()

        networkBytesReceived = 0
        connectionStatus = nil
        startDate = Date()

        pinger = Pinger(address: address, interfaceName: adapter.interfaceName)
        try pinger?.start(delay: Self.pingStartDelay, repeating: Self.pingInterval)

        timer = DispatchSource.makeTimerSource(queue: queue)
        timer?.setEventHandler { [weak self] in
            self?.onTimer()
        }
        timer?.schedule(wallDeadline: .now(), repeating: Self.statsQueryInterval)
        timer?.resume()
    }

    func stop() {
        stateLock.lock()

        pinger?.stop()
        pinger = nil

        timer?.cancel()
        timer = nil

        startDate = nil

        stateLock.unlock()
    }

    private func onTimer() {
        adapter.getRuntimeConfiguration { [weak self] str in
            self?.handleRuntimeConfiguration(string: str)
        }
    }

    private func handleRuntimeConfiguration(string: String?) {
        guard let string = string else {
            logger.debug("Received no runtime configuration from WireGuard adapter.")
            return
        }

        guard let newNetworkBytesReceived = Self.parseNetworkBytesReceived(from: string) else {
            logger.debug("Failed to parse rx_bytes from runtime configuration.")
            return
        }

        stateLock.lock()
        defer { stateLock.unlock() }
        let oldNetworkBytesReceived = self.networkBytesReceived
        networkBytesReceived = newNetworkBytesReceived

        if newNetworkBytesReceived != oldNetworkBytesReceived {
            self.logger.debug("Got newNetworkBytesReceived = \(newNetworkBytesReceived), oldNetworkBytesReceived = \(oldNetworkBytesReceived)")
        }

        switch self.connectionStatus {
        case .none:
            if newNetworkBytesReceived > oldNetworkBytesReceived {
                let newConnectionStatus = ConnectionStatus.established

                connectionStatus = newConnectionStatus
                logger.debug("Connection established.")

                queue.async {
                    self.delegate?.tunnelMonitor(self, connectionStatusDidChange: newConnectionStatus)
                }
            } else if let startDate = self.startDate, Date().timeIntervalSince(startDate) >= Self.connectionTimeout {
                let newConnectionStatus = ConnectionStatus.lost

                connectionStatus = newConnectionStatus
                logger.debug("Connection lost.")

                self.queue.async {
                    self.delegate?.tunnelMonitor(self, connectionStatusDidChange: newConnectionStatus)
                }
            }

        case .established:
            break

        case .lost:
            if newNetworkBytesReceived > oldNetworkBytesReceived {
                let newConnectionStatus = ConnectionStatus.established

                connectionStatus = newConnectionStatus
                logger.debug("Connection changed from lost to established.")

                queue.async {
                    self.delegate?.tunnelMonitor(self, connectionStatusDidChange: newConnectionStatus)
                }
            }
        }
    }

    private class func parseNetworkBytesReceived(from string: String) -> UInt64? {
        guard let range = string.range(of: "rx_bytes=") else { return nil }

        let startIndex = range.upperBound
        let endIndex = string[startIndex...].firstIndex { ch in
            return ch.isNewline
        }

        if let endIndex = endIndex {
            return UInt64(string[startIndex..<endIndex])
        } else {
            return nil
        }
    }
}
