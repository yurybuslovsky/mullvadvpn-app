package net.mullvad.mullvadvpn.ui.listitemview

import android.content.Context
import androidx.appcompat.view.ContextThemeWrapper
import net.mullvad.mullvadvpn.R

class SearchListItemView(context: Context) :
    ActionListItemView(
        ContextThemeWrapper(context, R.style.ListItem_Action_SearchView),
        defStyleAttr = 0
    ) {
    override val layoutRes: Int
        get() = R.layout.list_item_plain_text
    override val heightRes: Int
        get() = R.dimen.search_view_height

    override fun updateAction() {
        itemText.setOnClickListener(clickListener)
    }
}
