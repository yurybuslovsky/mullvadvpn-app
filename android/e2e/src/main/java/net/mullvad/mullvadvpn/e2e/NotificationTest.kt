package net.mullvad.mullvadvpn.e2e

import androidx.test.uiautomator.By
import junit.framework.Assert.assertNotNull
import net.mullvad.mullvadvpn.e2e.constant.CONNECTION_TIMEOUT
import net.mullvad.mullvadvpn.e2e.extension.findObjectWithTimeout
import org.junit.Test

class NotificationTest : EndToEndTest() {
    @Test
    fun testConnectFromNotification() {
        // Given
        app.launchAndEnsureLoggedIn()

        // When
        device.openNotification()
        notificationStack.ensureNotificationExpandedByTitle("Mullvad VPN")
        notificationStack.clickNotificationActionButtonByText("SECURE MY CONNECTION")
        device.pressBack()

        // Then
        device.findObjectWithTimeout(By.text("OK")).click()
        assertNotNull(
            device.findObjectWithTimeout(
                By.text("SECURE CONNECTION"),
                CONNECTION_TIMEOUT
            )
        )
    }
}
