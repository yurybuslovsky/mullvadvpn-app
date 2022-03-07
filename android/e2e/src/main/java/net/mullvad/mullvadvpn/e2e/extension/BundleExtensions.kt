package net.mullvad.mullvadvpn.e2e.extension

import android.os.Bundle
import net.mullvad.mullvadvpn.e2e.constant.TEST_ACCOUNT_TOKEN_ARGUMENT_KEY

fun Bundle.testAccountToken(): String {
    return getString(TEST_ACCOUNT_TOKEN_ARGUMENT_KEY)
        ?: throw IllegalArgumentException("Missing test account token.")
}
