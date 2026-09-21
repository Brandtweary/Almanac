# Almanac

*Local AI for self-reliance and homesteading.*

Nearly everything you need to grow food, manage water, or fix a machine is already written
down and freely available. The hard part is sifting through it with the problem in front of
you and no expert to call. Almanac is an offline reference library with a local AI assistant
on top, one that can search the collection, read the relevant pages, and talk you through a
procedure by voice while your hands stay on the work. It is built for homesteads,
preparedness, and off-grid communities.

The model and the library both run on a machine you control. Inference, speech, and the
installed collection keep working with the network unplugged; web search is available when
you are online, and says so plainly when you are not.

## Working with the library

Ask a question in ordinary language. Almanac searches the installed collection, reads the
passages that look relevant, and follows up when it needs more to answer. Tool cards show
each search it runs and each passage it reads. Beneath a researched answer, a sources list
links to the documents the answer cites; when an answer cites nothing, the material it merely
consulted is listed under its own label instead, which does not claim to support the answer.
Depending on the document, a link opens a page or downloads the original file.

In practice: whether the garlic goes in before this frost or after it, why the well pump is
short-cycling and what to rule out before pulling it apart, processing times for a batch of
tomatoes at your altitude, the clearances for a barn subpanel read back to you while both
hands are busy.

## The collection

The searchable installation is English Wikipedia (full articles without images), Appropedia's
practical-reference archive, CD3WD's development and trades manuals, and a scripture and
canon collection drawn from English Wikisource and Project Gutenberg. The
[collection guide](./docs/library.md) lists sources, editions, and publisher links, along with
further reference originals — food preservation, crop water needs, seed production, drinking
water, wood properties, electrical work, machining, and emergency care — which you download
from their publishers and add yourself. Every document remains useful on its own, with or
without the assistant.

## Using Almanac

- **Voice:** Local speech-to-text and local text-to-speech. Ctrl+Space starts or stops
  recording; Ctrl+Alt+Space stops playback.
- **Optional memory:** Two mechanisms, both kept in your browser and both off until you turn
  them on. A personal glossary holds short definitions of the terms you use — your land, your
  tools, your way of doing things — so the same words carry the same meanings in every
  conversation. A running context holds a brief summary of each recent chat, so today picks up
  where yesterday left off.
- **Document attachments:** Bring your own reference documents, with previews for PDFs, Office
  documents, and spreadsheets.
- **Web search:** Optional online discovery through a local SearXNG service, for questions the
  installed library cannot answer.

## The stack

Everything below runs on the machine you install it on. Nothing calls out to a hosted model,
and the gateway holds no provider keys and no billing state.

| | |
|---|---|
| **Language model** | Muse Glimmer 30B, NVFP4, 131,072-token context |
| **Inference server** | vLLM, from a pinned model snapshot |
| **Hardware target** | One 32 GB consumer GPU |
| **Interface** | Browser front end running the Pi agent loop |
| **Gateway** | Bun / Hono, one completion at a time |
| **Library service** | Python, over an immutable ingested generation of each archive |
| **Lexical search** | SQLite FTS5, plus each archive's own native index where it has one |
| **Semantic search** | Qdrant, embedded with `all-MiniLM-L6-v2` |
| **Speech in** | faster-whisper, local |
| **Speech out** | Pocket TTS on CPU, stock Alba voice |
| **Web search** | SearXNG, local, optional |
| **Your data** | IndexedDB, in your browser |

Longer descriptions, for anyone installing or modifying it: [browser runtime](./docs/browser-oracle.md),
[gateway](./proxy/README.md), [content service](./content/README.md), [CPU speech](./speech/README.md),
[self-hosting](./docs/self-hosting.md), and [web search](./docs/web-search.md).

## Installation

Almanac installs from source on Linux. [Source-based installation](./docs/install.md#source-based-local-setup)
covers the browser, gateway, library, and CPU speech; [runtime startup](./docs/source-runtime.md)
gives the exact model acquisition, inference, encoder, vector-store, and transcription commands.
A certified portable bundle is not supplied, and whole-installation qualification — complete
library indexes, long-window checks, and offline release measurement — is separate from the
component results documented alongside it.

For frontend development:

```sh
git clone https://github.com/Brandtweary/Almanac.git almanac
cd almanac
npm ci
npm run dev        # Vite development server
npm run check      # TypeScript checks
npm run build      # Production frontend bundle
```

These commands build and serve the browser interface. They do not provision the model, speech
services, or reference library; those belong to the installation process above.

## What it is, and what it isn't

The model is an off-the-shelf open-weights release and the collection is public archives anyone
can download; the contribution is the interface and the packaging around them. Almanac is a
research assistant, not a coding assistant: it can walk you through work somebody has already
written down, but it will not stand up a production codebase or crack a hard engineering
problem. Everything under that ceiling keeps working with the network unplugged.

Appropriate technology has always meant tools you can own, repair, and understand, and there is
no good reason to hold AI apart from that. A capable model on your own machine, reading a
library on your own disk, belongs in a workshop or a farmhouse. Almanac is a proof of concept
for that: a single machine a household or a community can own, run, and maintain, holding a
library that stays readable whether or not the machine does.

## Provenance and license

Almanac's browser interface uses the vendored [pi-web-ui](./src/pi-web-ui/) and its
conversations run through Pi's agent library. The application is [MIT licensed](./LICENSE); the
vendored interface retains its [upstream MIT notice](./src/pi-web-ui/LICENSE).

Books, maps, and model weights retain their own licenses and attribution requirements. The
application's license does not grant redistribution rights to the contents of a library.
