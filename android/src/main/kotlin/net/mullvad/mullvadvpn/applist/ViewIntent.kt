package net.mullvad.mullvadvpn.applist

import net.mullvad.mullvadvpn.model.ListItemData

sealed class ViewIntent {
    data class ChangeApplicationGroup(val item: ListItemData) : ViewIntent()
    data class SearchApplication(val term: String?) : ViewIntent()
    object ViewIsReady : ViewIntent()
}
