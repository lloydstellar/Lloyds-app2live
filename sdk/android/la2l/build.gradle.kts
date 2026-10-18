plugins {
    id("com.android.library")
}

android {
    namespace = "nl.lloydstellar.la2l"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    testOptions {
        // Android classes answer with defaults in JVM tests, so the code can tell it is not on a phone.
        unitTests.isReturnDefaultValues = true
        unitTests.all {
            it.systemProperty("la2l.repository", rootDir.resolve("../..").canonicalPath)
            it.systemProperty("la2l.version", project.version.toString())
        }
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    // Android has org.json built in; JVM tests need the real one.
    testImplementation("org.json:json:20260814")
}

extra["artifact"] = "la2l"
extra["about"] = "Send sounds from an Android app to Ableton Live with LA2L (Lloyd's App2Live)."
apply(from = rootProject.file("publish.gradle.kts"))
