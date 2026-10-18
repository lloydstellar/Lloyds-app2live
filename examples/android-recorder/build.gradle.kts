import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The recorder example: built in GitHub Actions with the SDK of this repository
// (sdk/android/settings.gradle.kts includes it). In an app of your own, use
// implementation("nl.lloydstellar:la2l-ktx:0.1.0") from https://lloydstellar.nl/la2l/maven/.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "nl.lloydstellar.la2l.recorder"
    compileSdk = 36

    defaultConfig {
        applicationId = "nl.lloydstellar.la2l.recorder"
        minSdk = 24
        // 34: Android 15 and newer draw an app targeting 35 under the system bars, which this
        // small layout does not handle.
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_11)
    }
}

dependencies {
    implementation(project(":la2l-ktx"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
}
