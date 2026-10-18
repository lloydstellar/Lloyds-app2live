package nl.lloydstellar.la2l;

/** The result of a call, on the main thread of an Android app. */
public interface Callback<T> {
    void onSuccess(T value);

    void onError(La2lException error);
}
