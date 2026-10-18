package nl.lloydstellar.la2l;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.List;

/**
 * Lets the app the user picks read the WAV files of a share (La2lShare), and nothing else: only
 * files in the share folder of the app's cache, read-only, and only with the permission the share
 * grants. Declared in la2l's manifest, not exported.
 */
public final class La2lFileProvider extends ContentProvider {

    @Override
    public boolean onCreate() {
        return true;
    }

    // content://<app>.la2l.files/<share>/<file> -> the file, if it is in the share folder.
    private File fileOf(Uri uri) throws FileNotFoundException {
        List<String> parts = uri.getPathSegments();
        if (getContext() == null || parts.size() != 2) throw new FileNotFoundException(uri.toString());
        File base = new File(getContext().getCacheDir(), La2lShare.FOLDER);
        File file = new File(new File(base, parts.get(0)), parts.get(1));
        try {
            String root = base.getCanonicalPath() + File.separator;
            if (!file.getCanonicalPath().startsWith(root) || !file.isFile()) throw new FileNotFoundException(uri.toString());
        } catch (IOException e) {
            throw new FileNotFoundException(uri.toString());
        }
        return file;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Read only.");
        return ParcelFileDescriptor.open(fileOf(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file;
        try {
            file = fileOf(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] columns = projection != null ? projection : new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        Object[] row = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) row[i] = file.getName();
            else if (OpenableColumns.SIZE.equals(columns[i])) row[i] = file.length();
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        return "audio/wav";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("Read only.");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Read only.");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Read only.");
    }
}
