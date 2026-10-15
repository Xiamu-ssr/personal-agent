// Package the selected 3D mascot into the macOS iconset. No custom avatar silhouettes remain.
import AppKit
let out=URL(fileURLWithPath:CommandLine.arguments[1])
let source=CommandLine.arguments.count>2 ? CommandLine.arguments[2] : "Resources/Mascot/idle/still.png"
guard let mascot=NSImage(contentsOfFile:source) else { fatalError("缺少头像静帧") }
try FileManager.default.createDirectory(at:out,withIntermediateDirectories:true)
for base in [16,32,128,256,512] {
    for scale in [1,2] {
        let px=base*scale,s=CGFloat(px)
        let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:px,pixelsHigh:px,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
        NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:bitmap)
        let rect=NSRect(x:s*0.08,y:s*0.08,width:s*0.84,height:s*0.84)
        NSColor.white.setFill();NSBezierPath(roundedRect:rect,xRadius:s*0.19,yRadius:s*0.19).fill()
        mascot.draw(in:NSRect(x:s*0.1,y:s*0.1,width:s*0.8,height:s*0.8))
        NSGraphicsContext.restoreGraphicsState()
        let name=scale == 1 ? "icon_\(base)x\(base).png" : "icon_\(base)x\(base)@2x.png"
        try bitmap.representation(using:.png,properties:[:])!.write(to:out.appendingPathComponent(name))
    }
}
