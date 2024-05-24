# VS Code Qt Documentation Extension

This extension shows documentation for Qt methods and types when you hover over
them.

![Demo](docs/demo.gif)

## Setup & Configuration

After installing the extension, it may be necessary to configure paths to
where the Qt documentation is installed on your system.

### Linux

The extension will automatically search for Qt documentation files (`.qch`)
in `/usr/share/doc/qt5/` and `/usr/share/doc/qt6/`. Those paths (and files in
them) are usually provided by distribution packages. If you have your Qt
documentation installed in other location, you can specify the path in the
extension settings.

### MacOS & Windows

On MacOS and Windows it is necessary to configure the paths to Qt documentation
manually. After installation, the extension will inform you that there are no
search paths configured and ask you to set them up.

## Extension Settings

This extension contributes the following settings:

* `vscode-extension-qch.qtDocsPaths`: Paths to search for QCH files.

## Known Issues

* Constructors don't show documentation (issue #1)
* QML not supported (issue #2)
* Documentation for overloaded methods is not resolved correctly (issue #3)

## Contributing

You are more than welcome to contribute to this project, be it code,
documentation, localization or whatever else. Thank you!

To get started, simply fork our repository on GitHub, create a new branch
for your changes, and submit a pull request when you're ready.

## FAQ

### Where to Get Qt Documentation?

On Linux, it's usually available through distribution packages (usually called
`qt6-doc` in most distros). Other way how to obtain the documentation, which
applies to any platform is through the official
[Qt Installer](https://www.qt.io/download-qt-installer-oss). Finally, it's
also possible to build the Qt documentation yourself
[directly from Qt sources](https://wiki.qt.io/Building_Qt_Documentation),
either standalone or as part of compiling Qt yourself.

### Why a Special Extension for Qt?

Unlike most C++ projects, Qt keeps its API documentation in the `.cpp` files.
Therefore whe developing against Qt, the C++ Intellisense cannot see it, since
it only has access to Qt header files.

Qt instead compiles its documentation into a properietary QCH (Qt Compressed
Help) format (which really is just an SQLite database). This extension extracts
all documented symbols from the database and their documentation, so when you
hover over a Qt type or it's method, the extension can quickly look up the
documentation for it and provide it to VS Code.

## License

This project is published under the [MIT license](LICENSES/MIT.txt).