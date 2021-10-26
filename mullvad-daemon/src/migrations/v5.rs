use super::{Error, Result};
use crate::{device::DeviceService, DaemonEventSender, InternalDaemonEvent};
use mullvad_types::{
    account::AccountToken, device::DeviceData, settings::SettingsVersion, wireguard::WireguardData,
};
use talpid_core::mpsc::Sender;
use talpid_types::ErrorExt;


pub(crate) async fn migrate(
    settings: &mut serde_json::Value,
    runtime: tokio::runtime::Handle,
    rest_handle: mullvad_rpc::rest::MullvadRestHandle,
    daemon_tx: DaemonEventSender,
) -> Result<()> {
    if !version_matches(settings) {
        return Ok(());
    }

    log::info!("Migrating settings format to V6");

    if let Some(token) = settings.get("account_token").filter(|t| !t.is_null()) {
        let api_handle = rest_handle.availability.clone();
        let service = DeviceService::new(rest_handle, api_handle);
        let token: AccountToken =
            serde_json::from_value(token.clone()).map_err(Error::ParseError)?;
        if let Some(wg_data) = settings.get("wireguard").filter(|wg| !wg.is_null()) {
            let wg_data: WireguardData =
                serde_json::from_value(wg_data.clone()).map_err(Error::ParseError)?;
            log::info!("Creating a new device cache from previous settings");
            runtime.spawn(cache_from_wireguard_key(daemon_tx, service, token, wg_data));
        } else {
            log::info!("Generating a new device for the account");
            runtime.spawn(cache_from_account(daemon_tx, service, token));
        }

        // TODO: Remove account token
        // TODO: Remove wireguard data
    }

    settings["settings_version"] = serde_json::json!(SettingsVersion::V6);

    Ok(())
}

fn version_matches(settings: &mut serde_json::Value) -> bool {
    settings
        .get("settings_version")
        .map(|version| version == SettingsVersion::V5 as u64)
        .unwrap_or(false)
}

async fn cache_from_wireguard_key(
    daemon_tx: DaemonEventSender,
    service: DeviceService,
    token: AccountToken,
    wg_data: WireguardData,
) {
    let devices = match service.list_devices_with_backoff(token.clone()).await {
        Ok(devices) => devices,
        Err(error) => {
            log::error!(
                "{}",
                error.display_chain_with_msg("Failed to enumerate devices for account")
            );
            return;
        }
    };

    for device in devices.into_iter() {
        if device.pubkey == wg_data.private_key.public_key() {
            let _ = daemon_tx.send(InternalDaemonEvent::DeviceMigrationEvent(DeviceData {
                token,
                device,
                wg_data,
            }));
            return;
        }
    }
    log::info!("The existing WireGuard key is not valid; generating a new device");
    cache_from_account(daemon_tx, service, token).await;
}

async fn cache_from_account(
    daemon_tx: DaemonEventSender,
    service: DeviceService,
    token: AccountToken,
) {
    match service.generate_for_account_with_backoff(token).await {
        Ok(device_data) => {
            let _ = daemon_tx.send(InternalDaemonEvent::DeviceMigrationEvent(device_data));
        }
        Err(error) => log::error!(
            "{}",
            error.display_chain_with_msg("Failed to generate new device for account")
        ),
    }
}
