import Observation
import SwiftUI

/// Logged in or not, and whether the first-login capability walkthrough is done.
@Observable
final class Session {
    static let shared = Session()

    var configured = LocalVerification.explicitLoopback || Prefs.configured
    var onboarded = Prefs.onboarded

    func signedIn() {
        configured = true
        onboarded = Prefs.onboarded
        ChatClient.shared.reconnect()
        DeviceClient.shared.reregister()
    }

    func finishOnboarding() {
        Prefs.onboarded = true
        onboarded = true
        if Prefs.notifyMessages, let permit = Capabilities.all.first(where: { $0.name == "notify" })?.permit { Task { _ = await permit() } }
    }

    @MainActor
    func signOut() {
        ChatClient.shared.stop()
        DeviceClient.shared.stop()
        Composer.shared.reset()
        ConnectorStore.shared.reset()
        ProfileStore.shared.reset()
        SitePreviewCache.shared.clear()
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
                Orb(size: 84)
                VStack(spacing: 8) {
                    Text("登录豆豆").font(Theme.font(size: 28, weight: .bold)).foregroundStyle(Theme.ink)
                    Text("你的个人 agent，住在你自己的云主机上").font(Theme.font(size: 13.5)).foregroundStyle(Theme.sub)
                }
                VStack(alignment: .leading, spacing: 14) {
                    field("账号", hint: "云端地址") {
                        TextField(Prefs.defaultServer, text: $server).textFieldStyle(.plain)
                    }
                    field("密码", hint: "6 位配对码，或口令") {
                        SecureField("配对码或口令", text: $password).textFieldStyle(.plain).onSubmit(login)
                    }
                    if !error.isEmpty {
                        Label(error, systemImage: "exclamationmark.circle").font(Theme.font(size: 12.5)).foregroundStyle(Theme.danger)
                    }
                    Button(action: login) {
                        Text(checking ? "登录中…" : "登录").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(GoldButtonStyle(height: 44))
                    .disabled(checking || password.trimmingCharacters(in: .whitespaces).isEmpty)
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
        let address = server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Prefs.defaultServer : server.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
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

/// 开通本机能力: shown once after the first login.
struct OnboardingView: View {
    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 14) {
                        Orb(size: 52)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("开通本机能力").font(Theme.font(size: 26, weight: .bold)).foregroundStyle(Theme.ink)
                            Text("开了的，豆豆可以随时用；没开的，它碰不到。之后在「设置 → 连接应用」里随时改。")
                                .font(Theme.font(size: 13)).foregroundStyle(Theme.sub)
                        }
                    }
                    LocalCapabilityList()
                }
                .frame(maxWidth: 640)
                .padding(.horizontal, 36)
                .padding(.top, 48)
                .padding(.bottom, 20)
                .frame(maxWidth: .infinity)
            }
            .scrollContentBackground(.hidden)
            Button { Session.shared.finishOnboarding() } label: { Text("开始使用").frame(width: 220) }
                .buttonStyle(GoldButtonStyle(height: 44))
                .keyboardShortcut(.defaultAction)
                .padding(.bottom, 28)
                .padding(.top, 8)
        }
    }
}
