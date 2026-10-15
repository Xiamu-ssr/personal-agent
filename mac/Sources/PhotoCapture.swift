import AppKit
@preconcurrency import AVFoundation
import Observation
import SwiftUI

/// Local photo input only. Session/output work stays on queue; observable state and callbacks stay on main.
/// The manually enforced queue boundary permits capture by GCD without exporting any device capability.
@Observable final class PhotoCapture:NSObject,AVCapturePhotoCaptureDelegate,@unchecked Sendable {
    let session=AVCaptureSession()
    private let output=AVCapturePhotoOutput()
    private let queue=DispatchQueue(label:"Doudou.Camera")
    private var active=true
    var ready=false
    var opening=false
    var taking=false
    var error=""
    var onPhoto:((NSImage)->Void)?
    @MainActor func open() async {
        guard !opening && !ready else {return};opening=true;error=""
        let allowed=await AVCaptureDevice.requestAccess(for:.video)
        guard active else {return}
        guard allowed else {opening=false;error="相机未授权，可以在系统设置中开启，或直接添加图片。";return}
        queue.async { [weak self] in
            guard let self else {return}
            do {
                guard let camera=AVCaptureDevice.default(for:.video) else {throw CapError("没有可用的相机")}
                let input=try AVCaptureDeviceInput(device:camera)
                session.beginConfiguration();session.sessionPreset = .photo
                guard session.canAddInput(input),session.canAddOutput(output) else {session.commitConfiguration();throw CapError("相机暂时不可用")}
                session.addInput(input);session.addOutput(output);session.commitConfiguration();session.startRunning()
                DispatchQueue.main.async { [weak self] in
                    guard let self else {return};opening=false
                    if active {ready=true} else {stop()}
                }
            } catch {let message=error.localizedDescription;DispatchQueue.main.async { [weak self] in self?.opening=false;self?.error=message }}
        }
    }
    @MainActor func capture() {
        guard ready && !taking else {return};taking=true
        queue.async { [weak self] in guard let self else {return};output.capturePhoto(with:AVCapturePhotoSettings(format:[AVVideoCodecKey:AVVideoCodecType.jpeg]),delegate:self) }
    }
    func photoOutput(_ output:AVCapturePhotoOutput,didFinishProcessingPhoto photo:AVCapturePhoto,error:Error?) {
        let data=photo.fileDataRepresentation(),message=error?.localizedDescription
        DispatchQueue.main.async { [weak self] in
            guard let self,active else {return};taking=false
            if let message {self.error=message;return}
            guard let data,let image=NSImage(data:data) else {self.error="照片没有拍好，请再试一次";return}
            onPhoto?(image)
        }
    }
    @MainActor func stop() {active=false;ready=false;let session=self.session;queue.async { if session.isRunning {session.stopRunning()} }}
}
struct PhotoCaptureView:View {
    let onPhoto:(NSImage)->Void
    @Environment(\.dismiss) private var dismiss
    @State private var camera=PhotoCapture()
    var body:some View {
        VStack(alignment:.leading,spacing:18) {
            HStack {Text("拍照").font(Theme.titleFont(22));Spacer();CircleIconButton(icon:"xmark",help:"关闭相机"){dismiss()} }
            ZStack {Theme.card
                if camera.ready {CameraPreview(session:camera.session)}
                else {VStack(spacing:14) {
                    Image(systemName:"camera").font(.system(size:36,weight:.light))
                    Text(camera.error.isEmpty ? "拍一张照片，加到这条消息里" : camera.error).font(Theme.font(size:13)).multilineTextAlignment(.center)
                    Button(camera.opening ? "正在打开…" : "打开相机"){Task{await camera.open()}}.buttonStyle(PrimaryButtonStyle()).disabled(camera.opening)
                }.foregroundStyle(Theme.sub).padding(30)}
            }.frame(height:330).clipShape(RoundedRectangle(cornerRadius:20))
            HStack {Text("拍好后可和文字一起发送。").font(Theme.font(size:12)).foregroundStyle(Theme.sub);Spacer()
                Button(camera.taking ? "拍摄中…" : "拍照并添加"){camera.capture()}.buttonStyle(PrimaryButtonStyle()).disabled(!camera.ready || camera.taking)
            }
        }.padding(26).frame(width:560).background(Theme.background).foregroundStyle(Theme.ink).preferredColorScheme(Theme.scheme)
        .onAppear {camera.onPhoto={image in onPhoto(image);dismiss()}}
        .onDisappear {camera.stop()}
    }
}
private struct CameraPreview:NSViewRepresentable {
    let session:AVCaptureSession
    func makeNSView(context:Context)->Preview {Preview(session:session)}
    func updateNSView(_ view:Preview,context:Context) {}
    static func dismantleNSView(_ view:Preview,coordinator:()) {view.preview.session=nil}
    final class Preview:NSView {
        let preview:AVCaptureVideoPreviewLayer
        init(session:AVCaptureSession) {preview=AVCaptureVideoPreviewLayer(session:session);super.init(frame:.zero);wantsLayer=true;preview.videoGravity = .resizeAspectFill;layer?.addSublayer(preview)}
        required init?(coder:NSCoder){fatalError()}
        override func layout(){super.layout();preview.frame=bounds}
    }
}
