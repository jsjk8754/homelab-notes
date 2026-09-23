HUGO_BIN ?= hugo

.PHONY: serve check build new-note new-project export-velog

serve:
	$(HUGO_BIN) server --buildDrafts --navigateToChanged

check:
	HUGO_BIN="$(HUGO_BIN)" ./scripts/check.sh

build:
	$(HUGO_BIN) --environment production --panicOnWarning --minify

new-note:
	@test -n "$(SLUG)" || (echo 'Usage: make new-note SLUG=my-note' >&2; exit 2)
	HUGO_BIN="$(HUGO_BIN)" ./scripts/new-content.sh notes "$(SLUG)"

new-project:
	@test -n "$(SLUG)" || (echo 'Usage: make new-project SLUG=my-project' >&2; exit 2)
	HUGO_BIN="$(HUGO_BIN)" ./scripts/new-content.sh projects "$(SLUG)"

export-velog:
	@test -n "$(SOURCE)" || (echo 'Usage: make export-velog SOURCE=stories/post.md [OUTPUT=/tmp/post.md]' >&2; exit 2)
	python3 scripts/export-velog.py "$(SOURCE)" $(if $(OUTPUT),--output "$(OUTPUT)",)
