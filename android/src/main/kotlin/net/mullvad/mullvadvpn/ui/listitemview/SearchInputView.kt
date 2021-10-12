package net.mullvad.mullvadvpn.ui.listitemview

import android.content.Context
import android.util.Log
import android.view.View
import android.widget.Toast
import androidx.appcompat.view.ContextThemeWrapper
import androidx.core.content.res.ResourcesCompat
import net.mullvad.mullvadvpn.R

class SearchInputView(context: Context) :
    ListItemView(ContextThemeWrapper(context, R.style.ListItem_SearchInputView)) {
    override val layoutRes: Int
        get() = R.layout.list_item_search_input

    override val heightRes: Int
        get() = R.dimen.cell_height

    init {
        setBackgroundColor(ResourcesCompat.getColor(resources, R.color.white, null))
        findViewById<View>(R.id.cancelButton)!!.setOnClickListener {
            listItemListener?.onItemAction(itemData)
        }
    }
}
