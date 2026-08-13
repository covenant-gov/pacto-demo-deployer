NODE ?= node
SCRIPT := pacto-demo.mjs

.PHONY: help up reload down down-wipe status wipe wipe-all

help:
	@$(NODE) $(SCRIPT) help

# PR / BRANCH / CLIENTS / PIN come from .env. Override on the command line:
# make up PR=123 CLIENTS=3
# make up BRANCH=feat/gov-ux-improvements CLIENTS=2
# make reload
LAUNCH_FLAGS :=
ifdef PR
  LAUNCH_FLAGS += --pr $(PR)
endif
ifdef BRANCH
  LAUNCH_FLAGS += --branch $(BRANCH)
endif
ifdef CLIENTS
  LAUNCH_FLAGS += --clients $(CLIENTS)
endif
ifdef ENV
  LAUNCH_FLAGS += --env $(ENV)
endif
ifdef PIN
  LAUNCH_FLAGS += --pin $(PIN)
endif

up:
	$(NODE) $(SCRIPT) up $(LAUNCH_FLAGS)

reload:
	$(NODE) $(SCRIPT) reload $(LAUNCH_FLAGS)

down:
	$(NODE) $(SCRIPT) down

down-wipe:
	$(NODE) $(SCRIPT) down --wipe

status:
	$(NODE) $(SCRIPT) status

# make wipe CLIENT=1
wipe:
	@if [ -z "$(CLIENT)" ]; then echo "Set CLIENT=<n> (e.g. make wipe CLIENT=1)"; exit 1; fi
	$(NODE) $(SCRIPT) wipe --client $(CLIENT)

wipe-all:
	$(NODE) $(SCRIPT) wipe --all
