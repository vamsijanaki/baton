// baton-desktop-helper — small AppKit companion bundled with Baton.
//
//   baton-desktop-helper tint <source.icns> <dest.icns> <degrees>   hue-rotate an icon, write a new .icns
//   baton-desktop-helper seticon <image> <path>                     set a Finder custom icon on a file/bundle
//   baton-desktop-helper focus <pid>                                bring a running app to the front
//   baton-desktop-helper quit <pid>                                 ask a running app to quit (like ⌘Q)
//
// Exit status 0 on success, 1 on failure (reason on stderr), 2 on bad usage.

import AppKit
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("baton-desktop-helper: \(message)\n".utf8))
    exit(code)
}

func usage() -> Never {
    fail("usage: tint <src.icns> <dst.icns> <degrees> | seticon <image> <path> | focus <pid> | quit <pid>", code: 2)
}

/// The largest bitmap the icon file holds, as a CGImage.
func largestImage(at url: URL) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    var best: CGImage?
    for index in 0..<CGImageSourceGetCount(source) {
        guard let image = CGImageSourceCreateImageAtIndex(source, index, nil) else { continue }
        if best == nil || image.width * image.height > best!.width * best!.height { best = image }
    }
    return best
}

/// Draws `image` into a square RGBA bitmap of `pixels` × `pixels`.
func resized(_ image: CGImage, to pixels: Int) -> CGImage? {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: pixels, height: pixels))
    return context.makeImage()
}

func tint(source: String, destination: String, degrees: Double) {
    let input = URL(fileURLWithPath: source)
    guard let original = largestImage(at: input) else { fail("cannot read \(source)") }

    // Rotate the hue once at full size; greys and whites have no hue and stay as they are.
    let filter = CIFilter(name: "CIHueAdjust")!
    filter.setValue(CIImage(cgImage: original), forKey: kCIInputImageKey)
    filter.setValue(degrees * Double.pi / 180, forKey: kCIInputAngleKey)
    let ciContext = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!])
    guard let output = filter.outputImage,
          let rotated = ciContext.createCGImage(output, from: CGRect(x: 0, y: 0, width: original.width, height: original.height))
    else { fail("hue rotation failed") }

    let sizes = [16, 32, 128, 256, 512, 1024].filter { $0 <= max(original.width, 16) }
    let out = URL(fileURLWithPath: destination)
    guard let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.icns.identifier as CFString, sizes.count, nil) else {
        fail("cannot create \(destination)")
    }
    for size in sizes {
        guard let image = resized(rotated, to: size) else { fail("cannot render \(size)px") }
        CGImageDestinationAddImage(dest, image, nil)
    }
    if !CGImageDestinationFinalize(dest) { fail("cannot write \(destination)") }
}

func setIcon(image: String, target: String) {
    guard let picture = NSImage(contentsOfFile: image) else { fail("cannot read \(image)") }
    guard FileManager.default.fileExists(atPath: target) else { fail("\(target) does not exist") }
    if !NSWorkspace.shared.setIcon(picture, forFile: target, options: []) { fail("could not set the icon on \(target)") }
}

func runningApp(_ pidText: String) -> NSRunningApplication {
    guard let pid = pid_t(pidText), pid > 0 else { usage() }
    guard let app = NSRunningApplication(processIdentifier: pid) else { fail("no running app with pid \(pid)") }
    return app
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { usage() }

switch (command, args.count) {
case ("tint", 4):
    guard let degrees = Double(args[3]) else { usage() }
    tint(source: args[1], destination: args[2], degrees: degrees)
case ("seticon", 3):
    setIcon(image: args[1], target: args[2])
case ("focus", 2):
    let app = runningApp(args[1])
    if app.isHidden { app.unhide() }
    if !app.activate(options: [.activateAllWindows]) { fail("could not activate pid \(args[1])") }
case ("quit", 2):
    if !runningApp(args[1]).terminate() { fail("pid \(args[1]) did not accept the quit request") }
default:
    usage()
}
