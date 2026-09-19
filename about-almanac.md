# Almanac

*Local AI for self-reliance and homesteading.*

This website is a free hosted demo of Almanac, so you can try the application before running it on your own hardware.

Nearly everything you need to grow food, manage water, or fix a machine is already written down and freely available — just not in a form you can sift through with the problem in front of you and no expert to call. Almanac is an offline reference library with a local AI assistant on top, one that can talk you through a procedure by voice, the computer off to one side while your hands stay on the work. It is built for homesteads, preparedness, and off-grid communities.

## Working with the library

Ask a question in ordinary language. Almanac searches the collection, reads relevant passages, and follows up when it needs more information. Tool cards show its searches and the passages it reads. A sources list beneath each researched answer links to the documents the answer cites; when it cites none, the material it merely consulted is listed under its own label instead. Depending on the document, a link opens a page or downloads a file.

In practice: whether the garlic goes in before this frost or after it, why the well pump is short-cycling and what to rule out before pulling it apart, processing times for a batch of tomatoes at your altitude, the clearances for a barn subpanel read back to you while both hands are busy.

## The collection

- **English Wikipedia:** Full articles without images, covering science, technology, history, and general reference.
- **Appropedia:** Practical material on sustainable living, appropriate technology, agriculture, water, sanitation, construction, and energy.
- **CD3WD:** The compact web archive of development manuals and technical reference material, including farming, food processing, building, and trades.
- **Additional manuals:** Food preservation, crop-water needs, seed production, drinking-water systems, wood properties, electrical work, machining, and emergency care. Licensing varies by publisher, so these are not bundled: you download them yourself, and can index them alongside the rest.

The [collection guide](https://github.com/Brandtweary/Almanac/blob/main/docs/library.md) lists sources, editions, and publisher links. The documents remain useful independently of the assistant.

## Using Almanac

- **Voice:** Local speech-to-text and local text-to-speech. Ctrl+Space starts or stops recording; Ctrl+Alt+Space stops text-to-speech.
- **Optional memory:** Two mechanisms, both kept in your browser and both off until you turn them on. A personal glossary holds short definitions of the terms you use — your land, your tools, your way of doing things — so the same words carry the same meanings in every conversation. A running context holds a brief summary of each recent chat, so today picks up where yesterday left off.
- **Document attachments:** Bring your own reference documents, with previews for PDFs, Office documents, and spreadsheets.

## Local operation

The reference setup runs Muse Glimmer with a 131,072-token context on a single RTX 5090 with 32 GB of VRAM. The setup requires one high-end consumer GPU, not a cluster of datacenter GPUs.

Inference, speech, and the installed library work without an internet connection. Optional web search provides access to current information when you are online. Chats and personal memory are stored in your browser.

The demo processes requests on its server. A local installation runs them on your own hardware.

## What it is, and what it isn't

The model is an off-the-shelf open-weights release and the collection is public archives anyone can download; the contribution is the interface and the packaging around them. Almanac is a research assistant, not a coding assistant: it can walk you through work somebody has already written down, but it will not stand up a production codebase or crack a hard engineering problem. Everything under that ceiling keeps working with the network unplugged.

Appropriate technology has always meant tools you can own, repair, and understand, and there is no good reason to hold AI apart from that. A capable model on your own machine, reading a library on your own disk, belongs in a workshop or a farmhouse — a patient reference librarian who never closes. Almanac is a proof of concept for that, and a look at what AI can be in the communities building something durable.

[Source code and installation](https://github.com/Brandtweary/Almanac#installation)
