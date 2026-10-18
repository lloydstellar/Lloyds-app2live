// The Android SDK of LA2L: nl.lloydstellar:la2l (Java, no dependencies) and nl.lloydstellar:la2l-ktx
// (Kotlin on top), with the two example apps of the repository. Built only in GitHub Actions
// (sdk/BUILD-PROMPT.md, section 12.5), with Gradle 8.14 and the Android Gradle Plugin 8.13.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "la2l-android"

include(":la2l", ":la2l-ktx", ":android-recorder", ":android-java")
project(":android-recorder").projectDir = file("../../examples/android-recorder")
project(":android-java").projectDir = file("../../examples/android-java")
