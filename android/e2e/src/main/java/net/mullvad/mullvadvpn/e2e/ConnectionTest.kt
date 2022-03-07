package net.mullvad.mullvadvpn.e2e

import androidx.test.uiautomator.By
import junit.framework.Assert.assertEquals
import net.mullvad.mullvadvpn.e2e.extension.findObjectWithTimeout
import net.mullvad.mullvadvpn.e2e.interactor.WebViewInteractor
import org.junit.Test

class ConnectionTest : EndToEndTest() {
    @Test
    fun testConnectAndVerifyWithConnectionCheck() {
        // Given
        app.launchAndEnsureLoggedIn()

        // When
        device.findObjectWithTimeout(By.text("Secure my connection")).click()
        device.findObjectWithTimeout(By.text("OK")).click()
        device.findObjectWithTimeout(By.text("SECURE CONNECTION"))
        val expected = WebViewInteractor.ConnCheckState(true, app.extractIpAddress())

        // Then
        val result = web.launchAndExtractConnCheckState()
        assertEquals(expected, result)
    }
}
