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
    func tunnelMonitorDidDetermineConnectionEstablished(_ tunnelMonitor: TunnelMonitor)
    func tunnelMonitorDelegateShouldHandleConnectionRecovery(_ tunnelMonitor: TunnelMonitor)
}

struct TunnelMonitorConfiguration {
    /// Interval at which to query the adapter for stats.
    let wgStatsQueryInterval: DispatchTimeInterval = .milliseconds(50)

    /// Interval for sending echo packets.
    let pingInterval: DispatchTimeInterval = .seconds(3)

    /// Delay before sending the first echo packet.
    let pingStartDelay: DispatchTimeInterval = .milliseconds(500)

    /// Interval after which connection is treated as being lost.
    let connectionTimeout: TimeInterval = 15
}

class TunnelMonitor {
    private let configuration = TunnelMonitorConfiguration()

    private let adapter: WireGuardAdapter
    private let internalQueue = DispatchQueue(label: "TunnelMonitor")
    private let delegateQueue: DispatchQueue

    private var address: IPv4Address?
    private var pinger: Pinger?
    private var pathMonitor: NWPathMonitor?
    private var networkBytesReceived: UInt64 = 0
    private var lastAttemptDate = Date()
    private var isPinging = false

    private var logger = Logger(label: "TunnelMonitor")
    private var timer: DispatchSourceTimer?

    private weak var _delegate: TunnelMonitorDelegate?
    weak var delegate: TunnelMonitorDelegate? {
        set {
            internalQueue.sync {
                _delegate = newValue
            }
        }
        get {
            return internalQueue.sync {
                return _delegate
            }
        }
    }

    init(queue: DispatchQueue, adapter: WireGuardAdapter) {
        delegateQueue = queue
        self.adapter = adapter
    }

    deinit {
        stopNoQueue()
    }

    func start(address: IPv4Address) {
        internalQueue.async {
            self.startNoQueue(address: address)
        }
    }

    func stop() {
        internalQueue.async {
            self.stopNoQueue()
        }
    }

    private func startNoQueue(address pingAddress: IPv4Address) {
        stopNoQueue()

        address = pingAddress
        networkBytesReceived = 0
        lastAttemptDate = Date()

        let newPathMonitor = NWPathMonitor()
        newPathMonitor.pathUpdateHandler = { [weak self] path in
            self?.handleNetworkPathUpdate(path)
        }
        newPathMonitor.start(queue: internalQueue)
        pathMonitor = newPathMonitor

        handleNetworkPathUpdate(newPathMonitor.currentPath)
    }

    private func stopNoQueue() {
        address = nil

        pathMonitor?.cancel()
        pathMonitor = nil

        cancelWgStatsTimer()
        stopPinging()
    }

    private func startPinging(address: IPv4Address) throws {
        let newPinger = Pinger(address: address, interfaceName: adapter.interfaceName)
        try newPinger.start(delay: configuration.pingStartDelay, repeating: configuration.pingInterval)

        pinger = newPinger
        isPinging = true
    }

    private func stopPinging() {
        pinger?.stop()
        pinger = nil

        isPinging = false
    }

    private func setWgStatsTimer() {
        // Cancel existing timer.
        cancelWgStatsTimer()

        // Create new timer.
        timer = DispatchSource.makeTimerSource(queue: internalQueue)
        timer?.setEventHandler { [weak self] in
            self?.onWgStatsTimer()
        }
        timer?.schedule(wallDeadline: .now(), repeating: configuration.wgStatsQueryInterval)
        timer?.resume()

        logger.debug("Set WG stats timer.")
    }

    private func cancelWgStatsTimer() {
        timer?.cancel()
        timer = nil
    }

    private func onWgStatsTimer() {
        adapter.getRuntimeConfiguration { [weak self] str in
            guard let self = self else { return }

            self.internalQueue.async {
                self.handleWgStatsUpdate(string: str)
            }
        }
    }

    private func handleWgStatsUpdate(string: String?) {
        guard let string = string else {
            logger.debug("Received no runtime configuration from WireGuard adapter.")
            return
        }

        guard let newNetworkBytesReceived = Self.parseNetworkBytesReceived(from: string) else {
            logger.debug("Failed to parse rx_bytes from runtime configuration.")
            return
        }
        
        let oldNetworkBytesReceived = self.networkBytesReceived
        networkBytesReceived = newNetworkBytesReceived

        if newNetworkBytesReceived < oldNetworkBytesReceived {
            logger.debug("Stats was reset? newNetworkBytesReceived = \(newNetworkBytesReceived), oldNetworkBytesReceived = \(oldNetworkBytesReceived)")
            return
        }

        if newNetworkBytesReceived > oldNetworkBytesReceived {
            // Tell delegate that connection is established.
            delegateQueue.async {
                self.delegate?.tunnelMonitorDidDetermineConnectionEstablished(self)
            }

            // Stop the tunnel monitor.
            stopNoQueue()
        } else if Date().timeIntervalSince(lastAttemptDate) >= configuration.connectionTimeout {
            // Tell delegate to attempt the connection recovery.
            delegateQueue.async {
                self.delegate?.tunnelMonitorDelegateShouldHandleConnectionRecovery(self)
            }

            // Reset the last recovery attempt date so that we periodically notify the delegate
            // to perform the recovery.
            lastAttemptDate = Date()
        }
    }

    private func handleNetworkPathUpdate(_ networkPath: Network.NWPath) {
        guard let address = address else {
            return
        }

        let hasConnectivity = isNetworkPathReachable(networkPath)

        switch (hasConnectivity, isPinging) {
        case (true, false):
            logger.debug("Network is reachable. Starting to ping.")

            do {
                try startPinging(address: address)
                setWgStatsTimer()
            } catch {
                logger.error(chainedError: AnyChainedError(error), message: "Failed to start pinging.")
            }

        case (false, true):
            logger.debug("Network is unreachable. Stop pinging and wait...")
            cancelWgStatsTimer()
            stopPinging()

        default:
            break
        }
    }

    private func isNetworkPathReachable(_ networkPath: Network.NWPath) -> Bool {
        // Get utun interface name.
        guard let tunName = adapter.interfaceName else { return false }

        // Check if utun is up.
        let utunUp = networkPath.availableInterfaces.contains { interface in
            return interface.name == tunName
        }

        // Return false if tunnel is down.
        guard utunUp else {
            return false
        }

        // Return false if utun is the only available interface.
        if networkPath.availableInterfaces.count == 1 {
            return false
        }

        switch networkPath.status {
        case .requiresConnection, .satisfied:
            return true
        case .unsatisfied:
            return false
        @unknown default:
            return false
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
