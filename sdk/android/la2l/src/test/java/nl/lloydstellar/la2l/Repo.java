package nl.lloydstellar.la2l;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

// The repository the tests run in: the shared fixtures, and the server and the SDK for the
// integration tests. Gradle passes its folder as a system property.
final class Repo {
    private Repo() {}

    static File file(String path) {
        String root = System.getProperty("la2l.repository");
        if (root == null) throw new IllegalStateException("Run the tests through Gradle: it says where the repository is.");
        return new File(root, path);
    }

    static String read(String path) throws IOException {
        return new String(Files.readAllBytes(file(path).toPath()), StandardCharsets.UTF_8);
    }
}
