package io.github.yjw071218.ollamawebui.client;

import java.io.IOException;
import java.util.*;

/** Activities for one server share its origin, authentication gate and storage. */
final class ClientGateways {
    private static final Map<String, Entry> entries = new HashMap<>();
    private static final class Entry {
        final LoopbackProxy proxy;
        int users = 1;
        Entry(LoopbackProxy proxy) { this.proxy = proxy; }
    }
    static synchronized LoopbackProxy acquire(String server, int port, Set<Integer> reserved) throws Exception {
        Entry existing = entries.get(server);
        if (existing != null) { existing.users++; return existing.proxy; }
        LoopbackProxy candidate = new LoopbackProxy(server, port);
        if (port == 0) {
            for (int attempt = 0; reserved.contains(candidate.port()); attempt++) {
                candidate.close();
                if (attempt > 50) throw new IOException("No free port for the app.");
                candidate = new LoopbackProxy(server, 0);
            }
        }
        entries.put(server, new Entry(candidate));
        return candidate;
    }
    static synchronized void release(LoopbackProxy proxy) {
        Iterator<Entry> it = entries.values().iterator();
        while (it.hasNext()) {
            Entry entry = it.next();
            if (entry.proxy != proxy) continue;
            if (--entry.users == 0) { it.remove(); proxy.close(); }
            return;
        }
    }
}
