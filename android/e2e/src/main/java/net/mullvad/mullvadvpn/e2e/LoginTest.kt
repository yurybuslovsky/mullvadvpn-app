package net.mullvad.mullvadvpn.e2e

import androidx.test.runner.AndroidJUnit4
import androidx.test.uiautomator.By
import junit.framework.Assert.assertNotNull
import net.mullvad.mullvadvpn.e2e.constant.LOGIN_FAILURE_TIMEOUT
import net.mullvad.mullvadvpn.e2e.extension.findObjectWithTimeout
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LoginTest : EndToEndTest() {
    @Test
    fun testLoginWithInvalidCredentials() {
        // Given
        val invalidDummyAccountToken = "1337133713371337"

        // When
        app.launch()
        app.attemptLogin(invalidDummyAccountToken)

        // Then
        device.findObjectWithTimeout(By.text("Login failed"), LOGIN_FAILURE_TIMEOUT)
    }

    @Test
    fun testLoginWithValidCredentials() {
        // Given
        val token = testAccountToken

        // When
        app.launchAndEnsureLoggedIn(token)

        // Then
        app.ensureLoggedIn()
    }

    @Test
    fun testLogout() {
        // Given
        app.launchAndEnsureLoggedIn(testAccountToken)

        // When
        app.clickSettingsCog()
        app.clickListItemByText("Account")
        app.clickActionButtonByText("Log out")

        // Then
        assertNotNull(device.findObjectWithTimeout(By.text("Login")))
    }
}
