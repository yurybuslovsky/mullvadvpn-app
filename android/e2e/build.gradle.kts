import com.android.build.gradle.internal.cxx.configure.gradleLocalProperties
import java.util.Properties

plugins {
    id(Dependencies.Plugin.androidTestId)
    id(Dependencies.Plugin.kotlinAndroidId)
}

android {
    compileSdkVersion(Versions.Android.compileSdkVersion)
    buildToolsVersion(Versions.Android.buildToolsVersion)

    defaultConfig {
        minSdkVersion(Versions.Android.minSdkVersion)
        targetSdkVersion(Versions.Android.targetSdkVersion)
        testApplicationId = "net.mullvad.mullvadvpn.e2e"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        targetProjectPath = ":app"

        val e2eProperties = Properties().apply {
            load(project.file("e2e.properties").inputStream())
        }

        e2eProperties.getProperty("api_base_url", "").also { apiBaseUrl ->
            if (apiBaseUrl != null) {
                buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrl\"")
            } else {
                throw GradleException("Missing required property: api_base_url")
            }
        }

        e2eProperties.getProperty("api_version").also { apiVersion ->
            if (apiVersion != null) {
                buildConfigField("String", "API_VERSION", "\"$apiVersion\"")
            } else {
                throw GradleException("Missing required property: api_version")
            }
        }

        val testAccountToken = rootProject.properties.getOrDefault("test_account_token", null) as? String
                ?: gradleLocalProperties(rootProject.projectDir).getProperty("test_account_token")
                ?: ""

        testInstrumentationRunnerArguments += mapOf(
            "clearPackageData" to "true",
            "test_account_token" to testAccountToken
        )
    }

    testOptions {
        execution = "ANDROIDX_TEST_ORCHESTRATOR"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = Versions.jvmTarget
    }

}

val localScreenshotPath = "$buildDir/reports/androidTests/connected/screenshots"
val deviceScreenshotPath = "/sdcard/Pictures/Screenshots"

tasks.register("createDeviceScreenshotDir", Exec::class) {
    executable = android.adbExecutable.toString()
    args = listOf("shell", "mkdir", "-p", deviceScreenshotPath)
}

tasks.register("createLocalScreenshotDir", Exec::class) {
    executable = "mkdir"
    args = listOf("-p", localScreenshotPath)
}

tasks.register("clearDeviceScreenshots", Exec::class) {
    executable = android.adbExecutable.toString()
    args = listOf("shell", "rm", "-r", deviceScreenshotPath)
}

tasks.register("fetchScreenshots", Exec::class) {
    executable = android.adbExecutable.toString()
    args = listOf("pull", "$deviceScreenshotPath/.", localScreenshotPath)

    dependsOn(tasks.getByName("createLocalScreenshotDir"))
    finalizedBy(tasks.getByName("clearDeviceScreenshots"))
}

tasks.whenTaskAdded {
    if (name == "connectedDebugAndroidTest") {
        dependsOn(tasks.getByName("createDeviceScreenshotDir"))
        finalizedBy(tasks.getByName("fetchScreenshots"))
    }
}

dependencies {
    implementation(Dependencies.AndroidX.testCore)
    implementation(Dependencies.AndroidX.testOrchestrator)
    implementation(Dependencies.AndroidX.testRunner)
    implementation(Dependencies.AndroidX.testRules)
    implementation(Dependencies.AndroidX.testUiAutomator)
    implementation(Dependencies.androidVolley)
    implementation(Dependencies.Kotlin.stdlib)
}
