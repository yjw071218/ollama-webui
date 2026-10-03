import io.github.yjw071218.ollamawebui.client.LoopbackProxy;
public class ProxyHarness {
    public static void main(String[] args) throws Exception {
        try (LoopbackProxy proxy = new LoopbackProxy(args[0], 0)) {
            System.out.println(proxy.origin + " " + proxy.token);
            System.out.flush();
            System.in.read();
        }
    }
}
