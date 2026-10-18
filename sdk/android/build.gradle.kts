plugins {
    id("com.android.library") version "8.13.2" apply false
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.3.21" apply false
}

// One version for both libraries; La2l.VERSION must say the same (VersionTest checks it).
allprojects {
    group = "nl.lloydstellar"
    version = "0.1.0"
}
