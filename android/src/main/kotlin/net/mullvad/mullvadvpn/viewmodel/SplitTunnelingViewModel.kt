package net.mullvad.mullvadvpn.viewmodel

import android.text.Layout
import android.text.Spanned
import android.text.SpannedString
import android.text.style.AlignmentSpan
import android.util.Log
import androidx.annotation.StringRes
import androidx.core.text.bold
import androidx.core.text.buildSpannedString
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import net.mullvad.mullvadvpn.R
import net.mullvad.mullvadvpn.applist.AppData
import net.mullvad.mullvadvpn.applist.ApplicationsProvider
import net.mullvad.mullvadvpn.applist.ViewIntent
import net.mullvad.mullvadvpn.model.ListItemData
import net.mullvad.mullvadvpn.model.WidgetState
import net.mullvad.mullvadvpn.ui.serviceconnection.SplitTunneling


class SplitTunnelingViewModel(
    private val appsProvider: ApplicationsProvider,
    private val splitTunneling: SplitTunneling,
    dispatcher: CoroutineDispatcher
) : ViewModel() {
    private val listItemsSink = MutableSharedFlow<List<ListItemData>>(replay = 1)
    // read-only public view
    val listItems: SharedFlow<List<ListItemData>> = listItemsSink.asSharedFlow()

    private val intentFlow = MutableSharedFlow<ViewIntent>()
    private val isUIReady = CompletableDeferred<Unit>()
    private val excludedApps: MutableMap<String, AppData> = mutableMapOf()
    private val notExcludedApps: MutableMap<String, AppData> = mutableMapOf()

    private val defaultListItems: List<ListItemData> = listOf(
        createTextItem(R.string.split_tunneling_description),
        createDivider(0),
        createSearchItem(R.string.search_hint)
    )
    private var isSystemAppsVisible = false

    init {
        viewModelScope.launch(dispatcher) {
            listItemsSink.emit(defaultListItems + createDivider(1) + createProgressItem())
            // this will be removed after changes on native to ignore enable parameter
            if (!splitTunneling.enabled)
                splitTunneling.enabled = true
            fetchData()
        }
        viewModelScope.launch(dispatcher) {
            intentFlow.shareIn(viewModelScope, SharingStarted.WhileSubscribed())
                .collect(::handleIntents)
        }
    }

    suspend fun processIntent(intent: ViewIntent) = intentFlow.emit(intent)

    override fun onCleared() {
        splitTunneling.persist()
        super.onCleared()
    }

    data class AppFilter(val isActive: Boolean, val term: String = "") {
        fun applyFilter(input: String): Boolean {
            return isActive.not() || input.contains(term, ignoreCase = true)
        }

        companion object {
            val ACTIVE_EMPTY = AppFilter(true, "")
            val INACTIVE_EMPTY = AppFilter(false, "")
        }
    }

    var appFilterCache = AppFilter.INACTIVE_EMPTY

    private suspend fun handleIntents(viewIntent: ViewIntent) {
        Log.d("TEST", "viewIntent: $viewIntent")
        when (viewIntent) {
            is ViewIntent.ChangeApplicationGroup -> {
                viewIntent.item.action?.let {
                    if (excludedApps.containsKey(it.identifier)) {
                        removeFromExcluded(it.identifier)
                    } else {
                        addToExcluded(it.identifier)
                    }
                    publishList(appFilterCache)
                }
            }
            is ViewIntent.ViewIsReady -> isUIReady.complete(Unit)
            is ViewIntent.ShowSystemApps -> {
                isSystemAppsVisible = viewIntent.show
                publishList(appFilterCache)
            }
            is ViewIntent.SearchApplication -> {
                if (isUIReady.isCompleted) {
                    appFilterCache = if (viewIntent.term == null) {
                        AppFilter.INACTIVE_EMPTY
                    } else {
                        AppFilter(true, viewIntent.term)
                    }

                    publishList(appFilterCache)
                }
            }
            // else -> Log.e("mullvad", "Unhandled ViewIntent: $viewIntent")
        }
    }

    private fun removeFromExcluded(packageName: String) {
        excludedApps.remove(packageName)?.let { appInfo ->
            notExcludedApps[packageName] = appInfo
            splitTunneling.includeApp(packageName)
        }
    }

    private fun addToExcluded(packageName: String) {
        notExcludedApps.remove(packageName)?.let { appInfo ->
            excludedApps[packageName] = appInfo
            splitTunneling.excludeApp(packageName)
        }
    }

    private suspend fun fetchData() {
        appsProvider.getAppsList()
            .partition { app -> splitTunneling.isAppExcluded(app.packageName) }
            .let { (excludedAppsList, notExcludedAppsList) ->
                // TODO: remove potential package names from splitTunneling list
                //       if they already uninstalled or filtered; but not in ViewModel
                excludedAppsList.map { it.packageName to it }.toMap(excludedApps)
                notExcludedAppsList.map { it.packageName to it }.toMap(notExcludedApps)
            }
        isUIReady.await()
        publishList(appFilterCache)
    }

    private suspend fun publishList(filter: AppFilter) {

        Log.d("WIP", "filter: $filter")

        // Show top information unless the user is in the search-state
        val listItems = ArrayList(
            if (filter.isActive) {
                emptyList()
            } else {
                defaultListItems
            }
        )

        // Show filtered excluded apps regardless of system app toggle
        val filteredExcludedApps = excludedApps.values
                .sortedBy { it.name }
                .filter { appData -> filter.applyFilter(appData.name) }

        filteredExcludedApps.map { info -> createApplicationItem(info, true) }
                .takeIf { it.isNotEmpty() }?.run {
                    listItems += createDivider(1)
                    listItems += createMainItem(R.string.exclude_applications)
                    listItems += this
                }

        // Prepare non-excluded app list which might also be used to determine whether the
        // "Show system apps" toggle should be shown.
        val filteredNonExcludedApps = notExcludedApps
                .filter { app -> !app.value.isSystemApp || isSystemAppsVisible }
                .filter { (appName, _) -> filter.applyFilter(appName) }

        fun doShowSystemApp(): Boolean {
            return true
            //return filteredNonExcludedApps.isNotEmpty()
        }

        if (doShowSystemApp()) {
                listItems += createDivider(2)
                listItems += createSwitchItem(R.string.show_system_apps, isSystemAppsVisible)
        }

            // TODO: Needs to be hidden in certain cases, e.g. when hiding system apps and only a
                // specific system app is matching the filter/term

        filteredNonExcludedApps.values
                .sortedBy { it.name }.map { info ->
                    createApplicationItem(info, false)
                }
                .takeIf { it.isNotEmpty() }?.run {
                    listItems += createMainItem(R.string.all_applications)
                    listItems += this
                }

        fun showNoResults(): Boolean {
            return filter.isActive && filteredExcludedApps.isEmpty() && filteredNonExcludedApps.isEmpty()
        }

        if (showNoResults()) {
            listItems.add(createDivider(1))

            val formattedText: SpannedString = buildSpannedString {
                append("No results for ")
                bold { append(filter.term) }

                if (isSystemAppsVisible) {
                    append(".\nTry a different search.")
                } else {
                    append(".\nTry a different search or toggle \"Show system apps\".")
                }

                setSpan(AlignmentSpan.Standard(Layout.Alignment.ALIGN_CENTER), 0,
                        length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }

            listItems.add(
                ListItemData.build("text_no_search_results") {
                    type = ListItemData.PLAIN
                    text = formattedText
                    action = ListItemData.ItemAction(text.toString())
                }
            )
        }
        listItemsSink.emit(listItems)
    }

    private fun createApplicationItem(appData: AppData, checked: Boolean): ListItemData =
        ListItemData.build(appData.packageName) {
            type = ListItemData.APPLICATION
            text = SpannedString.valueOf(appData.name)
            iconRes = appData.iconRes
            action = ListItemData.ItemAction(appData.packageName)
            widget = WidgetState.ImageState(
                if (checked) R.drawable.ic_icons_remove else R.drawable.ic_icons_add
            )
        }

    private fun createDivider(id: Int): ListItemData = ListItemData.build("space_$id") {
        type = ListItemData.DIVIDER
    }

    private fun createMainItem(@StringRes text: Int): ListItemData =
        ListItemData.build("header_$text") {
            type = ListItemData.ACTION
            textRes = text
        }

    private fun createTextItem(@StringRes text: Int): ListItemData =
        ListItemData.build("text_$text") {
            type = ListItemData.PLAIN
            textRes = text
            action = ListItemData.ItemAction(text.toString())
        }

    private fun createSearchItem(@StringRes text: Int): ListItemData =
        ListItemData.build("search_$text") {
            type = ListItemData.SEARCH_VIEW
            textRes = text
            action = ListItemData.ItemAction(text.toString())
        }

    private fun createProgressItem(): ListItemData = ListItemData.build(identifier = "progress") {
        type = ListItemData.PROGRESS
    }

    private fun createSwitchItem(@StringRes text: Int, checked: Boolean): ListItemData =
        ListItemData.build(identifier = "switch_$text") {
            type = ListItemData.ACTION
            textRes = text
            action = ListItemData.ItemAction(text.toString())
            widget = WidgetState.SwitchState(checked)
        }
}
