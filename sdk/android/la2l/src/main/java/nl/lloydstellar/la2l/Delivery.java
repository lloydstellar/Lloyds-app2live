package nl.lloydstellar.la2l;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import org.json.JSONArray;
import org.json.JSONObject;

/** A package that was sent: its status, until it is in Live. */
public final class Delivery {
    private static final List<String> STATUSES = Arrays.asList("uploading", "waiting", "imported", "partial", "failed", "expired");

    private final La2l la2l;
    private final String packageId;
    private final List<String> warnings;
    private final String expiresAt;

    Delivery(La2l la2l, String packageId, List<String> warnings, String expiresAt) {
        this.la2l = la2l;
        this.packageId = packageId;
        this.warnings = Collections.unmodifiableList(warnings);
        this.expiresAt = expiresAt;
    }

    /** The id the server gave the package. */
    public String getPackageId() {
        return packageId;
    }

    /** What LA2L takes but ignores, for example: Kick: role "drum" unknown. */
    public List<String> getWarnings() {
        return warnings;
    }

    /** When the server deletes the package, imported or not, or null. */
    public String getExpiresAt() {
        return expiresAt;
    }

    private String path(String end) {
        return "/packages/" + La2l.encode(packageId) + end;
    }

    DeliveryStatus status(Job job) throws La2lException {
        Http.Answer answer = la2l.http.call("GET", path("/status"), null, la2l.token(), Http.Retry.ALL, job);
        if (answer.status == 404) return new DeliveryStatus("expired", new ArrayList<DeliveryStatus.SoundResult>(), null, null);
        if (answer.status != 200) throw la2l.fail(answer, La2lException.Code.SERVER);
        JSONObject j = answer.json;
        String status = j.optString("status", "");
        if (!STATUSES.contains(status)) status = "waiting";
        List<DeliveryStatus.SoundResult> sounds = new ArrayList<>();
        JSONArray items = j.optJSONArray("items");
        if (items != null) {
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.optJSONObject(i);
                if (it == null) continue;
                String error = it.optString("error", "");
                sounds.add(new DeliveryStatus.SoundResult(it.optString("id", ""), it.optString("name", ""), "imported".equals(it.optString("status")) ? "imported" : "failed", error.isEmpty() ? null : error));
            }
        }
        String error = j.optString("error", "");
        String updatedAt = j.optString("updated_at", "");
        return new DeliveryStatus(status, sounds, error.isEmpty() ? null : error, updatedAt.isEmpty() ? null : updatedAt);
    }

    /** Where the package is now. A package the server no longer knows counts as expired. */
    public CompletableFuture<DeliveryStatus> statusAsync() {
        return La2l.run(job -> status(job));
    }

    public CompletableFuture<DeliveryStatus> status(Callback<DeliveryStatus> callback) {
        return La2l.deliver(statusAsync(), callback);
    }

    /**
     * Waits until the user clicks Import in Live, asking every 3 seconds. Resolves when the sounds
     * are in Live (imported, or partial with the result per sound); fails with IMPORT_FAILED or
     * EXPIRED. A short trouble with the network does not stop it.
     */
    public CompletableFuture<DeliveryStatus> importedAsync() {
        return La2l.run(job -> {
            for (;;) {
                DeliveryStatus st = null;
                try {
                    st = status(job);
                } catch (La2lException e) {
                    if (e.getCode() != La2lException.Code.NETWORK) throw e;
                }
                if (st != null && (st.status.equals("imported") || st.status.equals("partial"))) return st;
                if (st != null && st.status.equals("expired")) throw new La2lException(La2lException.Code.EXPIRED, "The package expired before it was imported in Live.");
                if (st != null && st.status.equals("failed")) {
                    String why = st.error;
                    if (why == null) {
                        why = "LA2L could not import it.";
                        for (DeliveryStatus.SoundResult s : st.sounds) {
                            if (s.status.equals("failed")) {
                                why = s.name + " " + (s.error != null ? s.error : "was not imported");
                                break;
                            }
                        }
                    }
                    throw new La2lException(La2lException.Code.IMPORT_FAILED, ("Live could not import it. " + why).trim());
                }
                job.sleep(3000);
            }
        });
    }

    public CompletableFuture<DeliveryStatus> imported(Callback<DeliveryStatus> callback) {
        return La2l.deliver(importedAsync(), callback);
    }

    /** Takes the package back, until it is in Live. */
    public CompletableFuture<Void> cancelAsync() {
        return La2l.run(job -> {
            Http.Answer answer = la2l.http.call("DELETE", path(""), null, la2l.token(), Http.Retry.ALL, job);
            if (answer.status == 200) return null;
            if (answer.status == 409) throw new La2lException(La2lException.Code.SERVER, answer.text(), 409, -1);
            if (answer.status == 404) throw new La2lException(La2lException.Code.EXPIRED, answer.text(), 404, -1);
            throw la2l.fail(answer, La2lException.Code.SERVER);
        });
    }

    public CompletableFuture<Void> cancel(Callback<Void> callback) {
        return La2l.deliver(cancelAsync(), callback);
    }
}
