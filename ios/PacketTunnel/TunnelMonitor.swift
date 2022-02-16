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

    /// Error emitted by TunnelMonitor.
    enum Error: LocalizedError {
        case createSocket
        case obtainTunnelInterfaceName
        case mapTunnelInterfaceNameToIndex(Int32)
        case bindSocket(Int32)
        case createRunLoop

        var errorDescription: String? {
            switch self {
            case .createSocket:
                return "Failure to create socket."
            case .bindSocket:
                return "Failure to bind socket to interface."
            case .obtainTunnelInterfaceName:
                return "Cannot obtain tunnel interface name."
            case .mapTunnelInterfaceNameToIndex:
                return "Cannot map interface name to index."
            case .createRunLoop:
                return "Failure to create run loop for socket."
            }
        }
    }

    private let stateLock = NSLock()
    private let adapter: WireGuardAdapter
    private let queue: DispatchQueue

    // Sender identifier passed along with ICMP packet.
    private let identifier: UInt16 = 757

    private var sequenceNumber: UInt16 = 0
    private var socket: CFSocket?
    private var rxBytes: UInt64 = 0
    private var startDate: Date?
    private var connectionStatus: ConnectionStatus?

    private var logger = Logger(label: "TunnelMonitor")
    private var statsQueryTimer: DispatchSourceTimer?
    private var pingTimer: DispatchSourceTimer?

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

    func start(address: IPv4Address) -> Result<(), TunnelMonitor.Error> {
        let newSocket = CFSocketCreate(kCFAllocatorDefault, AF_INET, SOCK_DGRAM, IPPROTO_ICMP, 0, nil, nil)

        guard let newSocket = newSocket else {
            return .failure(.createSocket)
        }

        guard let interfaceName = adapter.interfaceName else {
            return .failure(.obtainTunnelInterfaceName)
        }

        logger.debug("Bind socket to \(interfaceName)...")

        var index = if_nametoindex(interfaceName);
        guard index != 0 else {
            logger.debug("Cannot map interface name \"\(interfaceName)\" to index (errno: \(errno)).")
            return .failure(.mapTunnelInterfaceNameToIndex(errno))
        }

        let bindResult = setsockopt(
            CFSocketGetNative(newSocket),
            IPPROTO_IP,
            IP_BOUND_IF,
            &index,
            socklen_t(MemoryLayout.size(ofValue: index))
        )

        if bindResult == -1 {
            logger.error("Failed to bind socket to \"\(interfaceName)\" with index \(index) (errno: \(errno)).")

            return .failure(.bindSocket(errno))
        } else {
            logger.debug("Bound socket to \"\(interfaceName)\" with index \(index).")
        }

        let flags = CFSocketGetSocketFlags(newSocket)
        if (flags & kCFSocketCloseOnInvalidate) == 0 {
            CFSocketSetSocketFlags(newSocket, flags | kCFSocketCloseOnInvalidate)
        }

        guard let runLoop = CFSocketCreateRunLoopSource(kCFAllocatorDefault, newSocket, 0) else {
            return .failure(.createRunLoop)
        }

        CFRunLoopAddSource(CFRunLoopGetMain(), runLoop, .defaultMode)

        let newQueryTimer = DispatchSource.makeTimerSource(flags: [], queue: queue)
        newQueryTimer.setEventHandler { [weak self] in
            self?.onQueryTimer()
        }

        let newPingTimer = DispatchSource.makeTimerSource(flags: [], queue: queue)
        newPingTimer.setEventHandler { [weak self] in
            self?.sendPing(address: address)
        }

        stateLock.lock()

        if let socket = socket {
            CFSocketInvalidate(socket)
        }

        socket = newSocket
        rxBytes = 0
        connectionStatus = nil
        startDate = Date()

        statsQueryTimer?.cancel()
        statsQueryTimer = newQueryTimer

        pingTimer?.cancel()
        pingTimer = newPingTimer

        newQueryTimer.schedule(wallDeadline: .now(), repeating: Self.statsQueryInterval)
        newQueryTimer.resume()

        newPingTimer.schedule(wallDeadline: .now() + Self.pingStartDelay, repeating: Self.pingInterval)
        newPingTimer.resume()

        stateLock.unlock()

        return .success(())
    }

    func stop() {
        stateLock.lock()

        if let socket = socket {
            CFSocketInvalidate(socket)

            self.socket = nil
        }

        statsQueryTimer?.cancel()
        statsQueryTimer = nil

        pingTimer?.cancel()
        pingTimer = nil

        startDate = nil

        stateLock.unlock()
    }

    private func onQueryTimer() {
        adapter.getRuntimeConfiguration { [weak self] str in
            guard let self = self else { return }
            
            guard let str = str else {
                self.logger.debug("Received no runtime configuration from WireGuard adapter.")
                return
            }

            guard let newRxBytes = Self.parseRxBytes(str: str) else {
                self.logger.debug("Failed to parse rx bytes from runtime configuration.")
                return
            }

            self.stateLock.lock()
            let oldRxBytes = self.rxBytes

            if newRxBytes != oldRxBytes {
                self.logger.debug("Got newRxBytes = \(newRxBytes), (oldRxBytes: \(oldRxBytes))")
            }

            switch self.connectionStatus {
            case .none:
                if newRxBytes > oldRxBytes {
                    let newConnectionStatus = ConnectionStatus.established

                    self.connectionStatus = newConnectionStatus
                    self.logger.debug("Connection established.")

                    self.queue.async {
                        self.delegate?.tunnelMonitor(self, connectionStatusDidChange: newConnectionStatus)
                    }
                } else if let startDate = self.startDate, Date().timeIntervalSince(startDate) >= Self.connectionTimeout {
                    let newConnectionStatus = ConnectionStatus.lost

                    self.connectionStatus = newConnectionStatus
                    self.logger.debug("Connection lost.")

                    self.queue.async {
                        self.delegate?.tunnelMonitor(self, connectionStatusDidChange: newConnectionStatus)
                    }
                }

            case .established:
                break

            case .lost:
                if newRxBytes > oldRxBytes {
                    let newConnectionStatus = ConnectionStatus.established

                    self.connectionStatus = newConnectionStatus
                    self.logger.debug("Connection changed from lost to established.")

                    self.queue.async {
                        self.delegate?.tunnelMonitor(self, connectionStatusDidChange: newConnectionStatus)
                    }
                }
            }

            self.rxBytes = newRxBytes
            self.stateLock.unlock()
        }
    }

    private class func parseRxBytes(str: String) -> UInt64? {
        guard let range = str.range(of: "rx_bytes=") else { return nil }

        let startIndex = range.upperBound
        let endIndex = str[startIndex...].firstIndex { ch in
            return ch.isNewline
        }

        if let endIndex = endIndex {
            return UInt64(str[startIndex..<endIndex])
        } else {
            return nil
        }
    }

    private func sendPing(address: IPv4Address) {
        stateLock.lock()
        guard let socket = socket else {
            stateLock.unlock()
            return
        }
        stateLock.unlock()

        let payload = Data()
        var sa = sockaddr_in()
        sa.sin_len = UInt8(MemoryLayout.size(ofValue: sa))
        sa.sin_family = sa_family_t(AF_INET)
        sa.sin_addr = address.rawValue.withUnsafeBytes { buffer in
            return buffer.bindMemory(to: in_addr.self).baseAddress!.pointee
        }

        let sequenceNumber = nextSequenceNumber()
        let packetData = Self.createICMPPacket(identifier: identifier, sequenceNumber: sequenceNumber, payload: payload)

        let bytesSent = packetData.withUnsafeBytes { dataBuffer -> Int in
            return withUnsafeBytes(of: &sa) { bufferPointer in
                let sockaddrPointer = bufferPointer.bindMemory(to: sockaddr.self).baseAddress!

                return sendto(
                    CFSocketGetNative(socket),
                    dataBuffer.baseAddress!,
                    dataBuffer.count,
                    0,
                    sockaddrPointer,
                    socklen_t(MemoryLayout<sockaddr_in>.size)
                )
            }
        }

        if bytesSent == -1 {
            logger.debug("Failed to send echo (errno: \(errno)).")
        }
    }

    private func nextSequenceNumber() -> UInt16 {
        stateLock.lock()
        let (partialValue, isOverflow) = sequenceNumber.addingReportingOverflow(1)
        let nextSequenceNumber = isOverflow ? 0 : partialValue

        sequenceNumber = nextSequenceNumber
        stateLock.unlock()

        return nextSequenceNumber
    }

    private class func createICMPPacket(identifier: UInt16, sequenceNumber: UInt16, payload: Data) -> Data {
        // Create data buffer.
        var data = Data()

        // ICMP type.
        data.append(UInt8(ICMP_ECHO))

        // Code.
        data.append(UInt8(0))

        // Checksum.
        withUnsafeBytes(of: UInt16(0)) { data.append(Data($0)) }

        // Identifier.
        withUnsafeBytes(of: identifier.bigEndian) { data.append(Data($0)) }

        // Sequence number.
        withUnsafeBytes(of: sequenceNumber.bigEndian) { data.append(Data($0)) }

        // Append payload.
        data.append(contentsOf: payload)

        // Calculate checksum.
        let checksum = in_chksum(data)

        data.withUnsafeMutableBytes { buffer in
            buffer.storeBytes(of: checksum, toByteOffset: 2, as: UInt16.self)
        }

        return data
    }
}

private func in_chksum(_ data: Data) -> UInt16 {
    return data.withUnsafeBytes { buffer in
        let length = buffer.count

        var sum: Int32 = 0

        let isOdd = length  % 2 != 0
        let strideTo = isOdd ? length - 1 : length

        for offset in stride(from: 0, to: strideTo, by: 2) {
            let word = buffer.load(fromByteOffset: offset, as: UInt16.self)
            sum += Int32(word)
        }

        if isOdd {
            let byte = buffer.load(fromByteOffset: length - 1, as: UInt8.self)
            sum += Int32(byte)
        }

        sum = (sum >> 16) + (sum & 0xffff)
        sum += (sum >> 16)

        return UInt16(truncatingIfNeeded: ~sum)
    }
}
