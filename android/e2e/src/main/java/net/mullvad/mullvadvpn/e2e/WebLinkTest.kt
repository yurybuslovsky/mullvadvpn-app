package net.mullvad.mullvadvpn.e2e

import androidx.test.uiautomator.By
import net.mullvad.mullvadvpn.e2e.extension.findObjectWithTimeout
import org.junit.Test

class WebLinkTest : EndToEndTest() {
    @Test
    fun testOpenFaqFromApp() {
        // Given
        app.launch()

        // When
        app.clickSettingsCog()
        app.clickListItemByText("FAQs & Guides")

        // Then
        device.findObjectWithTimeout(By.text("Mullvad help center"))
    }
}
