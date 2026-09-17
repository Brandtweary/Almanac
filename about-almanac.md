# Almanac

*Local AI for self-reliance and homesteading.*

Almanac combines a local AI assistant with an offline reference library for homesteads, preparedness and off-grid communities. It helps you find information about growing food, managing water, maintaining shelter, repairing equipment and other practical work.

## Research with sources

Ask a question in ordinary language. Almanac searches the collection, reads relevant passages and follows up when it needs more information. Its answers link back to sources you can inspect. Tool cards show what it is doing, and you can stop a reply while it is working.

The model can miss details or misunderstand a source. References let you check the instructions against the original material and the equipment or conditions in front of you.

## The collection

- **English Wikipedia:** full articles without images, covering science, technology, history and general reference.
- **Appropedia:** practical material on sustainable living, appropriate technology, agriculture, water, sanitation, construction and energy.
- **CD3WD:** the compact web archive of development manuals and technical reference material, including farming, food processing, building and trades.
- **Additional manuals:** food preservation, crop-water needs, seed production, drinking-water systems, wood properties, electrical work, machining and emergency care.

The [collection guide](https://github.com/Brandtweary/Almanac/blob/main/docs/library.md) lists sources, editions and publisher links. The documents remain useful independently of the assistant.

## Using Almanac

- **Text and voice:** type a question or press Ctrl+Space to record; press it again to stop and send. Replies can be read aloud. Ctrl+Alt+Space stops the voice.
- **Saved conversations:** reopen earlier chats, start another, or export and import conversation files.
- **Optional memory:** retain useful context between conversations. The reference library works with memory switched off.
- **Document attachments:** bring your own reference documents, with previews for PDFs, Office documents and spreadsheets.
- **Long conversations:** automatic summaries keep the conversation within the model's context window while preserving the original history.
- **Guided first visit:** a short click-through tour explains the controls. Replay it from Quick start in the header.

## Local operation

The reference setup runs Muse Glimmer with a 131,072-token context on a single RTX 5090 with 32 GB of VRAM. The model was selected to run on consumer hardware rather than require a datacenter GPU.

Inference, speech and the installed library work without an internet connection. Optional web search provides access to current information when you are online. Chats and personal memory are stored in your browser.

This free hosted demo processes requests on its server. Install Almanac yourself to run that processing on hardware you control.

[Source code and installation](https://github.com/Brandtweary/Almanac#building-the-reading-room)
