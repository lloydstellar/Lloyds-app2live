// What both libraries share for publishing: a POM, a local repository in build/maven that the
// release workflow ships to https://lloydstellar.nl/la2l/maven/, and a signature when the key is
// there (SIGNING_KEY and SIGNING_PASSWORD, from GitHub secrets; never in the repository).
apply(plugin = "maven-publish")
apply(plugin = "signing")

val artifact = project.extra["artifact"] as String
val about = project.extra["about"] as String

afterEvaluate {
    configure<PublishingExtension> {
        publications {
            register<MavenPublication>("release") {
                from(components["release"])
                groupId = "nl.lloydstellar"
                artifactId = artifact
                version = project.version.toString()
                pom {
                    name.set(artifact)
                    description.set(about)
                    url.set("https://lloydstellar.nl/la2l/developers/android")
                    licenses {
                        license {
                            name.set("Apache License 2.0")
                            url.set("https://www.apache.org/licenses/LICENSE-2.0")
                        }
                    }
                    developers {
                        developer {
                            name.set("Lloyd Stellar")
                            url.set("https://lloydstellar.nl")
                        }
                    }
                    scm {
                        url.set("https://github.com/lloydstellar/Lloyds-app2live")
                    }
                }
            }
        }
        repositories {
            maven {
                name = "local"
                url = uri(rootProject.layout.buildDirectory.dir("maven"))
            }
        }
    }
    val key = providers.environmentVariable("SIGNING_KEY").orNull
    if (key != null) {
        configure<SigningExtension> {
            useInMemoryPgpKeys(key, providers.environmentVariable("SIGNING_PASSWORD").orNull)
            sign(the<PublishingExtension>().publications["release"])
        }
    }
}
