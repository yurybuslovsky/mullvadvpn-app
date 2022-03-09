package net.mullvad.mullvadvpn.e2e

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.AndroidJUnit4
import androidx.test.uiautomator.UiDevice
import net.mullvad.mullvadvpn.e2e.extension.testAccountToken
import net.mullvad.mullvadvpn.e2e.interactor.AppInteractor
import net.mullvad.mullvadvpn.e2e.interactor.MullvadAccountInteractor
import net.mullvad.mullvadvpn.e2e.misc.ScreenshotTakingRule
import net.mullvad.mullvadvpn.e2e.misc.SimpleMullvadHttpClient
import org.junit.Before
import org.junit.Rule
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
abstract class EndToEndTest {

    @Rule
    @JvmField
    val rule = ScreenshotTakingRule()

    lateinit var device: UiDevice
    lateinit var targetContext: Context
    lateinit var testAccountToken: String
    lateinit var app: AppInteractor
    lateinit var account: MullvadAccountInteractor

    @Before
    fun setup() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        targetContext = InstrumentationRegistry.getInstrumentation().targetContext
        testAccountToken = InstrumentationRegistry.getArguments().testAccountToken()

        app = AppInteractor(
            device,
            targetContext,
            testAccountToken
        )

        account = MullvadAccountInteractor(
            SimpleMullvadHttpClient(targetContext),
            testAccountToken
        )

        account.cleanupAccount()
    }
}
