# Almanac

*Local AI for self-reliance and homesteading.*

This website is a free hosted demo of Almanac, so you can try the application before running it on your own hardware.

Almanac combines a local AI assistant with an offline reference library for homesteads, preparedness and off-grid communities. It helps you find information about growing food, managing water, maintaining shelter, repairing equipment and other practical work.

## Working with the library

Ask a question in ordinary language. Almanac searches the collection, reads relevant passages and follows up when it needs more information. Tool cards show its searches and the passages it reads. A sources list beneath each researched answer links to the documents; search-only results are labeled separately. Depending on the document, a link opens a page or downloads a file.

## The collection

- **English Wikipedia:** full articles without images, covering science, technology, history and general reference.
- **Appropedia:** practical material on sustainable living, appropriate technology, agriculture, water, sanitation, construction and energy.
- **CD3WD:** the compact web archive of development manuals and technical reference material, including farming, food processing, building and trades.
- **Additional manuals:** food preservation, crop-water needs, seed production, drinking-water systems, wood properties, electrical work, machining and emergency care.

The [collection guide](https://github.com/Brandtweary/Almanac/blob/main/docs/library.md) lists sources, editions and publisher links. The documents remain useful independently of the assistant.

## Using Almanac

- **Voice:** local speech-to-text and TTS. Ctrl+Space starts or stops recording; Ctrl+Alt+Space stops TTS.
- **Optional memory:** retain useful context between conversations.
- **Document attachments:** bring your own reference documents, with previews for PDFs, Office documents and spreadsheets.

## Local operation

The reference setup runs Muse Glimmer with a 131,072-token context on a single RTX 5090 with 32 GB of VRAM. The setup requires one high-end consumer GPU, not a cluster of datacenter GPUs.

Inference, speech and the installed library work without an internet connection. Optional web search provides access to current information when you are online. Chats and personal memory are stored in your browser.

The demo processes requests on its server. A local installation runs them on your own hardware.

[Source code and installation](https://github.com/Brandtweary/Almanac#building-the-reading-room)
