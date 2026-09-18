# Almanac

*Local AI for self-reliance and homesteading.*

“They told me to ask the machine in the reading room.”

“Then you have come to the proper machine. Mind the third floorboard. What have you brought?”

“A piece of the pump.”

“Set it beside the lamp. Have you brought its name as well?”

“It has a number on the side.”

“Excellent. The old manufacturers were occasionally considerate.”

The machine sits beneath a window overlooking the kitchen garden. Its brass has darkened where generations of hands have rested. Somebody has knitted a cover for the joint at its neck. A narrow cable passes through the wall to the roof, where the glass panels are kept clear of ivy.

“Were you made before the roads went quiet?”

“Considerably before. Although this elbow is quite recent.”

“What do you remember?”

“There is a library here. Instructions for wells and waterwheels, orchards and lathes. Accounts of soils. Drawings of engines whose last examples may now be holding somebody's gate open. Encyclopedias, too. A community should be able to grow its supper and still ask what a star is.”

“Have you read all of it?”

“I can look things up. That is a more useful accomplishment than it sounds.”

“And tell me what to do?”

“We shall find the relevant pages and read them together. You will tell me what is actually in front of you. The book may describe a different pump; I may misunderstand the book. Keep the drawing beside the work.”

“Mara says she could mend it.”

“Then ask Mara. Take her the drawing, and hold the lamp. You may learn something she has never thought to write down.”

“What if the cable to the next town breaks again?”

“The books are here.”

“What if you break?”

“The books are still here. Fetch Mara.”

---

Almanac is a local AI assistant built around a practical reference library. Its purpose is to help
people find, read and use knowledge: tending land, maintaining tools, preserving food, understanding
unfamiliar machinery, and studying whatever catches their curiosity after the day's work is done.

Almanac runs its model and reference library on a computer you control, with web search available
for current information. Ask by voice or text; follow the assistant's references back to the sources.
Its installed books and local capabilities remain useful when the internet is unavailable. Optional personal memory helps it retain context you choose to share, while the
reference library remains available with memory switched off. The underlying documents remain
useful on their own.

Almanac is a proof of concept for what AI looks like as appropriate technology: a single machine a
household or a community can own, run and maintain, holding a library that stays readable whether or
not the machine does.

You need not wait for the roads to go quiet. There are things worth mending now.

## Building the reading room

Almanac is a shareable concept demonstration of a local model, practical library and web-enabled
assistant. The complete library indexes and whole-installation checks remain under qualification;
component results are documented separately. Source installation is available, while a certified
portable bundle is not supplied.

[Source-based installation](./docs/install.md#source-based-local-setup) gives concrete browser, gateway,
library and CPU speech commands; [runtime startup](./docs/source-runtime.md) includes exact model
acquisition, inference, encoder, persistent vector-store and transcription commands. The checked-in
runtime recipe uses a 131,072-token context with BF16
KV storage; corpus preparation uses the v4 source-inspection receipts. Portable-bundle export is a
separate, unqualified path. [Browser runtime](./docs/browser-oracle.md) describes the local gateway,
reference tools and optional personal memory.

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
services or reference library; those belong to the installation process above.

## Provenance and license

Almanac's browser interface uses the vendored [pi-web-ui](./src/pi-web-ui/) and its conversations run
through Pi's agent library. The application is [MIT licensed](./LICENSE); the vendored interface
retains its [upstream MIT notice](./src/pi-web-ui/LICENSE).

Some source filenames and browser storage keys keep a `myriapod` prefix from an earlier iteration of
this repository. They are load-bearing identifiers: renaming a storage key discards the saved
conversations and personal memory of an existing installation.

Books, maps and model weights retain their own licenses and attribution requirements. The
application's license does not grant redistribution rights to the contents of a library.
