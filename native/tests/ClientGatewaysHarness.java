package io.github.yjw071218.ollamawebui.client;

import java.net.*;
import java.util.*;

public final class ClientGatewaysHarness {
    public static void main(String[] args) throws Exception {
        String server = "http://127.0.0.1.nip.io:9";
        LoopbackProxy main = ClientGateways.acquire(server, 0, Collections.emptySet());
        int port = main.port();
        LoopbackProxy floating = ClientGateways.acquire(server, port, Collections.singleton(port));
        if (main != floating) throw new AssertionError("Activities must share the same origin and token");
        ClientGateways.release(main);
        HttpURLConnection request = (HttpURLConnection) new URL(floating.origin + "/__native/info").openConnection();
        request.setConnectTimeout(2000); request.setReadTimeout(2000);
        request.setRequestProperty("Cookie", LoopbackProxy.COOKIE + "=" + floating.token);
        try {
            if (request.getResponseCode() != 200) throw new AssertionError("Closing one activity broke the other");
        } finally { request.disconnect(); }
        ClientGateways.release(floating);
        LoopbackProxy reopened = ClientGateways.acquire(server, port, Collections.singleton(port));
        if (reopened == main || reopened.port() != port) throw new AssertionError("Origin must survive a cold restart");
        ClientGateways.release(reopened);
        System.out.println("PASS shared gateway, independent close, stable restart origin");
    }
}
