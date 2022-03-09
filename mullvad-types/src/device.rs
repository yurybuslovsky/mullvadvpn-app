use crate::{account::AccountToken, wireguard};
#[cfg(target_os = "android")]
use jnix::IntoJava;
use serde::{Deserialize, Serialize};
use talpid_types::net::wireguard::PublicKey;

/// UUID for a device.
pub type DeviceId = String;

/// Human-readable device identifier.
pub type DeviceName = String;

/// Contains data for a device returned by the API.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[cfg_attr(target_os = "android", derive(IntoJava))]
#[cfg_attr(target_os = "android", jnix(package = "net.mullvad.mullvadvpn.model"))]
pub struct Device {
    pub id: DeviceId,
    pub name: DeviceName,
    #[cfg_attr(target_os = "android", jnix(map = "|key| *key.as_bytes()"))]
    pub pubkey: PublicKey,
}

impl Eq for Device {}

impl Device {
    /// Return name with each word capitalized: "Happy Seagull" instead of "happy seagull"
    pub fn pretty_name(&self) -> String {
        self.name
            .split_whitespace()
            .map(|word| {
                let mut chars = word.chars();
                match chars.next() {
                    None => String::new(),
                    Some(c) => c.to_uppercase().chain(chars).collect(),
                }
            })
            .collect::<Vec<String>>()
            .join(" ")
    }
}

/// A complete device configuration.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct DeviceData {
    pub token: AccountToken,
    pub device: Device,
    pub wg_data: wireguard::WireguardData,
}

impl From<DeviceData> for Device {
    fn from(data: DeviceData) -> Device {
        data.device
    }
}

/// [`DeviceData`] excluding the private key.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[cfg_attr(target_os = "android", derive(IntoJava))]
#[cfg_attr(target_os = "android", jnix(package = "net.mullvad.mullvadvpn.model"))]
pub struct DeviceConfig {
    pub token: AccountToken,
    pub device: Device,
}

impl From<DeviceData> for DeviceConfig {
    fn from(data: DeviceData) -> DeviceConfig {
        DeviceConfig {
            token: data.token,
            device: data.device,
        }
    }
}

/// Emitted when logging in or out of an account, or when the device changes.
#[derive(Clone, Debug)]
#[cfg_attr(target_os = "android", derive(IntoJava))]
#[cfg_attr(target_os = "android", jnix(package = "net.mullvad.mullvadvpn.model"))]
pub struct DeviceEvent {
    /// Device that was affected.
    pub device: Option<DeviceConfig>,
    /// Indicates whether the change was initiated remotely or by the daemon.
    pub remote: bool,
}

impl DeviceEvent {
    pub fn new(data: Option<DeviceData>, remote: bool) -> DeviceEvent {
        DeviceEvent {
            device: data.map(DeviceConfig::from),
            remote,
        }
    }

    pub fn from_device(data: DeviceData, remote: bool) -> DeviceEvent {
        DeviceEvent {
            device: Some(DeviceConfig {
                token: data.token,
                device: data.device,
            }),
            remote,
        }
    }

    pub fn revoke(remote: bool) -> Self {
        Self {
            device: None,
            remote,
        }
    }
}

/// Emitted when a device is removed using the `RemoveDevice` RPC.
/// This is not sent by a normal logout or when it is revoked remotely.
#[derive(Clone, Debug)]
#[cfg_attr(target_os = "android", derive(IntoJava))]
#[cfg_attr(target_os = "android", jnix(package = "net.mullvad.mullvadvpn.model"))]
pub struct RemoveDeviceEvent {
    pub account_token: AccountToken,
    pub removed_device: Device,
    pub new_devices: Vec<Device>,
}
