NODE ?= node
SCRIPT := pacto-demo.mjs

CLIENTS ?= 1

.PHONY: help up down down-wipe status wipe wipe-all

help:
	@$(NODE) $(SCRIPT) help

# Seeds come from .env (copy .env.example). Optional ENV=/path/to/.env
# make up PR=123 CLIENTS=3
# make up BRANCH=feat/gov-ux-improvements CLIENTS=2
UP_FLAGS := up --clients $(CLIENTS)
ifneq ($(PR),)
  UP_FLAGS += --pr $(PR)
endif
ifneq ($(BRANCH),)
  UP_FLAGS += --branch $(BRANCH)
endif
ifneq ($(ENV),)
  UP_FLAGS += --env $(ENV)
endif
ifneq ($(PIN),)
  UP_FLAGS += --pin $(PIN)
endif

up:
	$(NODE) $(SCRIPT) $(UP_FLAGS)

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
