// The Java example: pairs and sends a tone it makes itself, with the callbacks of la2l. Built in
// GitHub Actions with the SDK of this repository (sdk/android/settings.gradle.kts includes it).
// In an app of your own: implementation("nl.lloydstellar:la2l:0.1.0") from
// https://lloydstellar.nl/la2l/maven/.
plugins {
    id("com.android.application")
}

android {
    namespace = "nl.lloydstellar.la2l.javaexample"
    compileSdk = 36

    defaultConfig {
        applicationId = "nl.lloydstellar.la2l.javaexample"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation(project(":la2l"))
}
