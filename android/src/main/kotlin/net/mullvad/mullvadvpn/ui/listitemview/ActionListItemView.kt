package net.mullvad.mullvadvpn.ui.listitemview

import android.content.Context
import android.content.res.Resources
import android.util.AttributeSet
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.core.view.isVisible
import net.mullvad.mullvadvpn.R
import net.mullvad.mullvadvpn.model.WidgetState
import net.mullvad.mullvadvpn.ui.listitemview.WidgetViewController.StandardController
import net.mullvad.mullvadvpn.ui.listitemview.WidgetViewController.SwitchController

open class ActionListItemView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = R.attr.actionListItemViewStyle,
    defStyleRes: Int = 0
) : ListItemView(context, attrs, defStyleAttr, defStyleRes) {

    protected var widgetController: WidgetViewController<*>? = null
    protected val itemText: TextView = findViewById(R.id.itemText)
    protected val itemIcon: ImageView? = findViewById(R.id.itemIcon)
    protected val widgetContainer: ViewGroup? = findViewById(R.id.widgetContainer)

    protected val clickListener = OnClickListener {
        itemData.action?.let { _ ->
            listItemListener?.onItemAction(itemData)
        }
    }

    override val layoutRes: Int
        get() = R.layout.list_item_action

    override val heightRes: Int
        get() = R.dimen.cell_height

    override fun onUpdate() {
        updateImage()
        updateText()
        updateWidget()
        updateAction()
    }

    protected open fun updateImage() {
        itemIcon?.run {
            try {
                itemData.iconRes?.let {
                    isVisible = true
                    setImageResource(it)
                    return
                }
            } catch (ignore: Resources.NotFoundException) {
                isVisible = true
                setImageResource(R.drawable.ic_icons_missing)
                return
            }

            isVisible = false
            setImageDrawable(null)
        }
    }

    protected open fun updateText() {
        itemData.textRes?.let {
            itemText.setText(it)
            return
        }
        itemData.text?.let {
            itemText.setText(it)
            return
        }
        itemText.text = ""
    }

    protected open fun updateAction() {
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

    protected open fun updateWidget() {
        widgetContainer?.run {
            itemData.widget.let { state ->
                when (state) {
                    is WidgetState.ImageState -> {
                        if (widgetController !is StandardController) {
                            removeAllViews()
                            isVisible = true
                            widgetController = StandardController(widgetContainer)
                        }
                        (widgetController as StandardController).updateState(state)
                    }
                    is WidgetState.SwitchState -> {
                        if (widgetController !is SwitchController) {
                            removeAllViews()
                            isVisible = true
                            widgetController = SwitchController(widgetContainer)
                        }
                        (widgetController as SwitchController).updateState(state)
                    }
                    null -> {
                        if (widgetController != null) {
                            widgetController = null
                            removeAllViews()
                            isVisible = false
                        }
                    }
                }
            }
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        widgetContainer?.requestLayout()
    }
}
