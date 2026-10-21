import Foundation
import CryptoKit
import AppKit
import ImageIO

/// Account-scoped bytes, conditional revalidation, disk persistence and one
/// in-flight request per resource. A cancelled view never cancels another reader.
actor ResourceCache {
    static let shared=ResourceCache()
    struct Entry {let data:Data;let etag:String;var checked:Date;var used:Date}
    struct Flight {let id:UUID;let task:Task<Data,Error>}
    private var entries:[String:Entry]=[:]
    private var flights:[String:Flight]=[:]
    private var epoch=0
    private var invalidatedAt=Date.distantPast
    private let limit=48*1024*1024
    static func identity(server:String=Prefs.server,token:String=Api.authToken)->String {hash(server+"\n"+token)}
    static func hash(_ value:String)->String {SHA256.hash(data:Data(value.utf8)).map{String(format:"%02x",$0)}.joined()}
    func value(_ path:String,force:Bool=false,server:String=Prefs.server,token:String=Api.authToken) async throws->Data {
        let external=URL(string:path).flatMap{["https","http"].contains($0.scheme?.lowercased() ?? "") ? $0:nil}
        let endpoint=path.hasPrefix("/api/") ? path:Api.filePath(path)
        var request:URLRequest
        if let external {request=URLRequest(url:external)}else{request=try Api.request(endpoint,server:server,token:token)}
        let key=Self.hash(Self.identity(server:server,token:token)+"\n"+(request.url?.absoluteString ?? path))
        let immutable=path.hasPrefix("/api/library/thumbnail?")&&path.contains("&rev=")
        let ttl:TimeInterval=immutable ? 365*86400:45
        if var entry=entries[key],!force,entry.checked>=invalidatedAt,Date().timeIntervalSince(entry.checked)<ttl {entry.used=Date();entries[key]=entry;return entry.data}
        if let flight=flights[key]{return try await flight.task.value}
        let root=(Prefs.isolatedRoot ?? FileManager.default.urls(for:.cachesDirectory,in:.userDomainMask)[0]).appendingPathComponent("Doudou/resources",isDirectory:true)
        let file=root.appendingPathComponent(key+".bin"),meta=root.appendingPathComponent(key+".json")
        var previous=entries[key]
        if previous==nil,let data=try? Data(contentsOf:file),let bytes=try? Data(contentsOf:meta),let record=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any] {
            previous=Entry(data:data,etag:record["etag"] as? String ?? "",checked:Date(timeIntervalSince1970:record["checked"] as? Double ?? 0),used:Date())
        }
        if let entry=previous,!force,entry.checked>=invalidatedAt,Date().timeIntervalSince(entry.checked)<ttl {entries[key]=entry;trim();return entry.data}
        if let tag=previous?.etag,!tag.isEmpty {request.setValue(tag,forHTTPHeaderField:"If-None-Match")}
        let old=previous,transport=Api.session,generation=epoch
        let task=Task<Data,Error> {
            let (bytes,response)=try await transport.data(for:request)
            let data:Data
            if (response as? HTTPURLResponse)?.statusCode==304,let old {data=old.data}
            else {try Api.validate(bytes,response);guard bytes.count<=20*1024*1024 else{throw ApiError(code:413,message:"文件过大")};data=bytes}
            try Task.checkCancellation()
            let etag=(response as? HTTPURLResponse)?.value(forHTTPHeaderField:"ETag") ?? old?.etag ?? ""
            if self.epoch==generation {
                self.entries[key]=Entry(data:data,etag:etag,checked:Date(),used:Date());self.trim()
                try? FileManager.default.createDirectory(at:root,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
                try? data.write(to:file,options:.atomic)
                try? JSONSerialization.data(withJSONObject:["etag":etag,"checked":Date().timeIntervalSince1970]).write(to:meta,options:.atomic)
                self.trimDisk(root)
            }
            return data
        }
        let flightID=UUID();flights[key]=Flight(id:flightID,task:task)
        defer{if flights[key]?.id==flightID {flights.removeValue(forKey:key)}}
        return try await task.value
    }
    func invalidate(){epoch += 1;invalidatedAt=Date();for flight in flights.values{flight.task.cancel()};flights=[:]}
    private func trim(){var bytes=entries.values.reduce(0){$0+$1.data.count};for (key,item) in entries.sorted(by:{$0.value.used<$1.value.used}) where bytes>limit {entries.removeValue(forKey:key);bytes -= item.data.count}}
    private func trimDisk(_ root:URL){
        guard let files=try? FileManager.default.contentsOfDirectory(at:root,includingPropertiesForKeys:[.contentModificationDateKey,.fileSizeKey]) else{return}
        let values=files.filter{$0.pathExtension=="bin"}.compactMap{url -> (URL,Int,Date)? in guard let v=try? url.resourceValues(forKeys:[.fileSizeKey,.contentModificationDateKey]) else{return nil};return (url,v.fileSize ?? 0,v.contentModificationDate ?? .distantPast)}.sorted{$0.2>$1.2}
        var bytes=0;for (url,size,_) in values{bytes += size;if bytes>128*1024*1024{try? FileManager.default.removeItem(at:url);try? FileManager.default.removeItem(at:url.deletingPathExtension().appendingPathExtension("json"))}}
    }
}

enum ImageDecode {
    @MainActor
    static func thumbnail(_ data:Data,maxPixels:Int=1600) async->NSImage? {
        let bitmap=await Task.detached(priority:.utility){()->CGImage? in
            guard let source=CGImageSourceCreateWithData(data as CFData,nil) else{return nil}
            return CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,kCGImageSourceThumbnailMaxPixelSize:maxPixels,kCGImageSourceShouldCacheImmediately:true] as CFDictionary)
        }.value
        if let bitmap{return NSImage(cgImage:bitmap,size:NSSize(width:bitmap.width,height:bitmap.height))}
        return NSImage(data:data)
    }
}
