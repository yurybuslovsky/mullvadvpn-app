//
//  GeoJSON.swift
//  MullvadVPN
//
//  Created by pronebird on 25/02/2021.
//  Copyright © 2021 Mullvad VPN AB. All rights reserved.
//

import Foundation
import CoreLocation
import MapKit

enum GeoJSON {}

extension GeoJSON {
    struct FeatureCollection: Decodable {
        let features: [Feature]

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let type = try container.decode(String.self, forKey: .type)

            if type == "FeatureCollection" {
                features = try container.decode([Feature].self, forKey: .features)
            } else {
                throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "FeatureCollection: Invalid type \(type)")
            }
        }

        var mkOverlays: [MKOverlay] {
            return features.flatMap { (feature) -> [MKOverlay] in
                // Some tools like mapshaper output empty features after optimizing out the geometry
                guard let geometry = feature.geometry else { return [] }

                switch geometry {
                case .polygon(let polygon):
                    return [polygon.mkPolygon]

                case .multiPolygon(let multiPolygon):
                    return multiPolygon.mkPolygons
                }
            }
        }

        private enum CodingKeys: String, CodingKey {
            case type, features
        }
    }

    fileprivate enum AnyDecodableValue: Decodable  {
        case boolean(Bool)
        case number(Int64)
        case string(String)
        case dictionary([String: AnyDecodableValue])
        case array([AnyDecodableValue])
        case `nil`

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()

            if container.decodeNil() {
                self = .nil
            } else if let value = try? container.decode(Bool.self) {
                self = .boolean(value)
            } else if let value = try? container.decode(Int64.self) {
                self = .number(value)
            } else if let value = try? container.decode(String.self) {
                self = .string(value)
            } else if let value = try? container.decode([String: AnyDecodableValue].self) {
                self = .dictionary(value)
            } else if let value = try? container.decode([AnyDecodableValue].self) {
                self = .array(value)
            } else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unknown value type")
            }
        }

        var anyValue: Any? {
            switch self {
            case .boolean(let value):
                return value
            case .number(let value):
                return value
            case .string(let value):
                return value
            case .dictionary(let value):
                return value.mapValues { $0.anyValue }
            case .array(let value):
                return value.map { $0.anyValue }
            case .nil:
                return nil
            }
        }
    }

    struct Feature: Decodable {
        let identifier: String?
        let geometry: Geometry?
        let properties: [String: Any?]?

        private enum CodingKeys: String, CodingKey {
            case identifier = "id", properties, type, geometry
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let type = try container.decode(String.self, forKey: .type)

            identifier = try container.decodeIfPresent(String.self, forKey: .identifier)
            properties = try container.decodeIfPresent(AnyDecodableValue.self, forKey: .properties)?.anyValue as? [String: Any?]

            if type == "Feature" {
                geometry = try container.decodeIfPresent(Geometry.self, forKey: .geometry)
            } else {
                throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "Feature: Invalid type \(type)")
            }
        }
    }

    enum Geometry: Decodable {
        case polygon(Polygon)
        case multiPolygon(MultiPolygon)

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let type = try container.decode(String.self, forKey: .type)

            switch type {
            case "Polygon":
                self = .polygon(try decoder.singleValueContainer().decode(Polygon.self))

            case "MultiPolygon":
                self = .multiPolygon(try decoder.singleValueContainer().decode(MultiPolygon.self))

            default:
                throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "Geometry: Unknown type \(type)")
            }
        }

        private enum CodingKeys: String, CodingKey {
            case type
        }
    }

    struct Polygon: Decodable {
        let coordinates: [[[Double]]]

        var mkPolygon: MKPolygon {
            let coords = self.geoCoordinates
            let exteriorCoordinates = coords.first ?? []
            let interiorPolygons = coords.dropFirst().map { (interiorCoords) -> MKPolygon in
                return MKPolygon(coordinates: interiorCoords, count: interiorCoords.count)
            }

            if exteriorCoordinates.count > 2 {
                let n = exteriorCoordinates.count - 1

                for i in 1 ..< n {
                    for j in 0 ..< i-1 {
                        if let intersection = intersectionBetweenSegmentsCL(exteriorCoordinates[i], exteriorCoordinates[i+1], exteriorCoordinates[j], exteriorCoordinates[j+1]) {
                            // do whatever you want with `intersection`

                            print("Error: Intersection @ \(intersection)")
                        }
                    }
                }
            }

            return MKPolygon(
                coordinates: exteriorCoordinates,
                count: exteriorCoordinates.count,
                interiorPolygons: interiorPolygons
            )
        }

        private var geoCoordinates: [[CLLocationCoordinate2D]] {
            return coordinates.map { (values) -> [CLLocationCoordinate2D] in
                return values.map { (coordinates) -> CLLocationCoordinate2D in
                    return CLLocationCoordinate2D(latitude: coordinates[1], longitude: coordinates[0])
                }
            }
        }
    }

    struct MultiPolygon: Decodable {
        let coordinates: [[[[Double]]]]

        var mkPolygons: [MKOverlay] {
            return coordinates.map { (values) -> MKPolygon in
                return Polygon(coordinates: values).mkPolygon
            }
        }
    }

    static func decodeGeoJSON(_ data: Data) throws -> [MKOverlay] {
        if #available(iOS 13, *) {
            let decoder = MKGeoJSONDecoder()
            let geoJSONObjects = try decoder.decode(data)

            return geoJSONObjects.flatMap { (object) -> [MKOverlay] in
                if let feat = object as? MKGeoJSONFeature {
                    return feat.geometry.compactMap { (geometry) -> MKOverlay? in
                        return geometry as? MKOverlay
                    }
                } else {
                    return []
                }
            }
        } else {
            let jsonDecoder = JSONDecoder()
            let featureCollection = try jsonDecoder.decode(GeoJSON.FeatureCollection.self, from: data)

            return featureCollection.mkOverlays
        }
    }
}

private func intersectionBetweenSegmentsCL(_ p0: CLLocationCoordinate2D, _ p1: CLLocationCoordinate2D, _ p2: CLLocationCoordinate2D, _ p3: CLLocationCoordinate2D) -> CLLocationCoordinate2D? {
    var denominator = (p3.longitude - p2.longitude) * (p1.latitude - p0.latitude) - (p3.latitude - p2.latitude) * (p1.longitude - p0.longitude)
    var ua = (p3.latitude - p2.latitude) * (p0.longitude - p2.longitude) - (p3.longitude - p2.longitude) * (p0.latitude - p2.latitude)
    var ub = (p1.latitude - p0.latitude) * (p0.longitude - p2.longitude) - (p1.longitude - p0.longitude) * (p0.latitude - p2.latitude)

    if (denominator < 0) {
        ua = -ua; ub = -ub; denominator = -denominator
    }

    if ua >= 0.0 && ua <= denominator && ub >= 0.0 && ub <= denominator && denominator != 0 {
        print("INTERSECT")
        return CLLocationCoordinate2D(latitude: p0.latitude + ua / denominator * (p1.latitude - p0.latitude), longitude: p0.longitude + ua / denominator * (p1.longitude - p0.longitude))
    }
    return nil
}
