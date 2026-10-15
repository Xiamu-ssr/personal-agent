import Observation
import SwiftUI

/// Logged in or not, and whether the first-login capability walkthrough is done.
@Observable
final class Session {
    static let shared = Session()

    var configured = LocalVerification.explicitLoopback || Prefs.configured

    func signedIn() {
        configured = true
        ChatClient.shared.reconnect()
        DeviceClient.shared.reregister()
    }

    @MainActor
    func signOut() {
        ChatClient.shared.stop()
        DeviceClient.shared.stop()
        Composer.shared.reset()
        ConnectorStore.shared.reset()
        ProfileStore.shared.reset()
        Api.clearCache()
        Markdown.clearCache()
        Prefs.signOut()
        Nav.shared.preview = nil
        Nav.shared.tab = .chat
        Nav.shared.stacks = [:]
        configured = false
    }
}

struct LoginView: View {
    @State private var server = Prefs.server
    @State private var password = ""
    @State private var error = ""
    @State private var checking = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 22) {
                AgentAvatar(size: 84)
                VStack(spacing: 8) {
                    Text("登录豆豆").font(Theme.font(size: 28, weight: .bold)).foregroundStyle(Theme.ink)
                    Text("你的个人 agent，住在你自己的云主机上").font(Theme.font(size: 13.5)).foregroundStyle(Theme.sub)
                }
                VStack(alignment: .leading, spacing: 14) {
                    field("云端地址", hint: "你的服务器") {
                        TextField("https://你的服务器/agent", text: $server).textFieldStyle(.plain)
                    }
                    field("配对码", hint: "6 位一次性配对码") {
                        SecureField("配对码或口令", text: $password).textFieldStyle(.plain).onSubmit(login)
                    }
                    if !error.isEmpty {
                        Label(error, systemImage: "exclamationmark.circle").font(Theme.font(size: 12.5)).foregroundStyle(Theme.danger)
                    }
                    Button(action: login) {
                        Text(checking ? "登录中…" : "登录").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle(height: 44))
                    .disabled(checking || server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .keyboardShortcut(.defaultAction)
                    .padding(.top, 4)
                }
                .frame(width: 360)
                .card(radius: 26, padding: 26)
                Text("没有密码？在已登录的设备上：设置 → 生成配对码").font(Theme.font(size: 12)).foregroundStyle(Theme.faint)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private func field<F: View>(_ label: String, hint: String, @ViewBuilder _ f: () -> F) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label).font(Theme.font(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
                Spacer()
                Text(hint).font(Theme.font(size: 11.5)).foregroundStyle(Theme.faint)
            }
            f()
                .font(Theme.font(size: 14))
                .padding(.horizontal, 14)
                .frame(height: 40)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.field))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.field, lineWidth: 1))
        }
    }

    /// Exactly six digits = pairing code (POST /api/pair); anything else is the token itself, checked with /api/state.
    private func login() {
        let secret = password.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !secret.isEmpty, !checking else { return }
        let address = server.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !address.isEmpty else { error = "请填写云端地址"; return }
        checking = true
        error = ""
        Task { @MainActor in
            do {
                let token = try await Api.authenticate(server: address, password: secret)
                Prefs.server = address
                Prefs.token = token
                password = ""
                Session.shared.signedIn()
            } catch {
                self.error = error.localizedDescription
            }
            checking = false
        }
    }
}
