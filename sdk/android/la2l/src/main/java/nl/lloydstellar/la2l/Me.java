package nl.lloydstellar.la2l;

/** Which computer this app is paired with. */
public final class Me {
    public final String deviceName;
    public final String appName;
    public final String pairedAt;

    Me(String deviceName, String appName, String pairedAt) {
        this.deviceName = deviceName;
        this.appName = appName;
        this.pairedAt = pairedAt;
    }
}
