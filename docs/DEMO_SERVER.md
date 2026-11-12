# Demo server

The **Demo server** page builds a NIOS-X server on Proxmox while a customer watches, and shows the Terraform code behind each Infoblox step. It takes the next free address from Infoblox, starts DNS on the new server with a demo zone, and proves the Proxmox host can look names up through it. **Tear down** removes it again.

> [!WARNING]
> **Build it** makes real things: a VM on your Proxmox host, and an IP space, subnet, address, host and DNS zone in your Infoblox tenant. Use a lab or demo tenant. **Tear down** deletes what the run made, after showing you the list.

## What you need first

| Where | Needs |
|---|---|
| Your computer | Bloxsmith installed with Homebrew or an installer script (see **Other ways to install** in the [README](../README.md#quick-start)). The Docker version from the quick start cannot run the demo, because its container has no OpenTofu and no SSH |
| Your computer | OpenTofu or Terraform. On macOS, `brew install opentofu` installs OpenTofu |
| Your computer | An SSH key that logs in to Proxmox without asking for a password, and `rsync` for the first copy of the image to Proxmox |
| Proxmox | Your own login with passwordless `sudo` for `bash` and `rsync` (next section), or `root` |
| Proxmox | `genisoimage` and `dig`, and a private bridge for the demo network (next section) |
| Infoblox | An API key that can create IP spaces, subnets and DNS zones, a join token, and the NIOS-X On-Prem QCOW2 image from the Portal's downloads |

## Set up Proxmox once (about 5 minutes)

Run these as `root` on the Proxmox host, from its web console (**Shell**) so a network mistake cannot lock you out. Replace `jsmith` with your own login.

```bash
# install sudo; a fresh Proxmox host does not have it
apt install -y sudo
```

```bash
# make your own login, if you do not have one on this host yet
adduser jsmith
```

```bash
# write a rule letting jsmith run bash and rsync as root without a password, to a scratch file first
echo 'jsmith ALL=(root) NOPASSWD: /usr/bin/bash, /usr/bin/rsync' > /root/bloxsmith-demo.sudo
```

```bash
# check the rule before it takes effect; this should print "parsed OK"
visudo -cf /root/bloxsmith-demo.sudo
```

```bash
# set the permissions sudo expects and move the rule into place; -n leaves an existing file alone
chmod 440 /root/bloxsmith-demo.sudo && mv -n /root/bloxsmith-demo.sudo /etc/sudoers.d/bloxsmith-demo
```

Bloxsmith sends each Proxmox step as a script to `sudo bash`, so this rule gives `jsmith` full root access without a password. Keep the SSH key for that login on your own computer only. To use `root` instead, skip these five commands.

The next commands add a private bridge, `vmbr9`, with the network `10.99.0.0/24`. Servers on it reach the internet through `vmbr0`. Pick another bridge name or network if those are taken, and use the same values in Bloxsmith's Settings.

```bash
# check that Proxmox reads extra network files; this should print a "source" line
grep source /etc/network/interfaces
```

```bash
# write the demo bridge settings to their own file; stops with "cannot overwrite existing file" if there is one already
set -C; cat > /etc/network/interfaces.d/bloxsmith-demo <<'EOF'
auto vmbr9
iface vmbr9 inet static
    address 10.99.0.1/24
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up   sysctl -w net.ipv4.ip_forward=1
    post-up   iptables -t nat -A POSTROUTING -s 10.99.0.0/24 -o vmbr0 -j MASQUERADE
    post-down iptables -t nat -D POSTROUTING -s 10.99.0.0/24 -o vmbr0 -j MASQUERADE
EOF
```

```bash
# bring up only the new bridge
ifup vmbr9
```

```bash
# install the two tools the demo uses
apt install -y genisoimage dnsutils
```

To undo it later, after tearing down every demo run, remove the files this setup made. Skip any that were already there before you started:

```bash
# take the demo bridge down and delete its settings file
ifdown vmbr9 && rm /etc/network/interfaces.d/bloxsmith-demo
```

```bash
# remove the sudo rule
rm /etc/sudoers.d/bloxsmith-demo
```

## Run the demo, step by step

1. In the menu on the left, open **Change** and click **Demo server**.
2. Fill in **Settings** and press **Save settings**. You do this once. The join token is kept encrypted and is never shown again.
3. Press **Preview**. It checks your settings, the API key, OpenTofu, the image, SSH to Proxmox and the bridge. Nothing is created yet. Fix anything marked as failed, then press **Preview** again.
4. Show the customer **The Infoblox code** panel. Its tabs (**Network**, **Next free IP**, **DNS**) hold the Terraform each step will run. The panel clears when the build finishes, so show it now or press **Preview** again afterwards.
5. Press **Build it**. The steps run in order: the demo network, the next free address, the VM, joining the Portal, DNS, and a name lookup from Proxmox. Once the image is on Proxmox it usually takes about five minutes, mostly waiting for the server to join. The first run also copies the image (about 3 GB), and a slow join can take up to 12 minutes.
6. When you are done, find the run under **Runs** and press **Tear down**. Read the list of what it will remove, then press **Remove these**.

Every run gets an ID like `c-20261030-150000`. The ID is tagged on the address, DNS service, name server group, zone and records that run made, and written into the VM's description, so you can see in the Portal and in Proxmox what the demo made. The shared demo IP space and subnet carry the tag `managed_by = bloxsmith` instead. Tear down checks each item still belongs to the run before deleting it, and leaves anything that fails a check alone. The demo network stays for the next run.

| Check that failed | Fix |
|---|---|
| OpenTofu or Terraform is installed | `brew install opentofu`, then press **Preview** again |
| Proxmox answers over SSH (and sudo runs) without a password | Copy your key with `ssh-copy-id jsmith@<proxmox-host>`. Then `ssh jsmith@<proxmox-host> sudo -n bash -c true` should return with no prompt |
| Proxmox has qm, genisoimage, dig and flock | On Proxmox: `apt install -y genisoimage dnsutils` |
| The demo bridge is up | Do **Set up Proxmox once** above, with the bridge and gateway from your Settings |
| The bloxsmith-demo IP space is free to create | Another copy of Bloxsmith made it. Delete it in the Infoblox Portal when no demo is running |
