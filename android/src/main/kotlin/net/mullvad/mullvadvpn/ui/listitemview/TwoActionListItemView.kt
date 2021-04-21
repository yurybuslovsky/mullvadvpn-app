package net.mullvad.mullvadvpn.ui.listitemview

import android.content.Context
import android.view.ViewGroup
import androidx.appcompat.view.ContextThemeWrapper
import net.mullvad.mullvadvpn.R

class TwoActionListItemView(context: Context) :
    ActionListItemView(ContextThemeWrapper(context, R.style.ListItem_Action_Double)) {
    override val layoutRes: Int
        get() = R.layout.list_item_two_action
    private val container: ViewGroup = findViewById(R.id.container_without_widget)

    init {
        isClickable = false
        isFocusable = false
    }

    override fun updateAction() {
        container.run {
            if (itemData.action == null) {
                setOnClickListener(null)
                isClickable = false
                isFocusable = false
            } else {
                setOnClickListener(clickListener)
                isClickable = true
                isFocusable = true
            }
        }
        widgetContainer?.run {
            setOnClickListener(clickListener)
            isClickable = true
            isFocusable = true
        }
    }
}
